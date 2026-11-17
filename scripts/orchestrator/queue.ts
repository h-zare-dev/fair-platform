import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { approvedIssue, GhTransport, type GitHubTransport } from './github.js';
import { paths } from './supervised.js';
import { StateStore, type TaskState } from './state.js';
import { loadConfig, verifyReceipt, type Receipt } from './runner.js';

const home = homedir();
const root = join(home, '.local/state/fair-platform');
const statusPath = join(root, 'queue.json');
const launchPath = join(root, 'supervised.launch');
const lockPath = join(root, 'supervised.lock');
const workerLockPath = join(root, 'queue-worker.lock');
const tokenPath = join(home, '.local/share/fair-platform/github-token');
const owner = 'h-zare-dev';
const repo = 'h-zare-dev/fair-platform';
export type QueueStatus = {
  status:
    | 'IDLE'
    | 'STARTING'
    | 'RUNNING'
    | 'PAUSED_QUOTA'
    | 'BLOCKED_APPROVAL'
    | 'BLOCKED_RECONCILIATION'
    | 'DONE';
  issue?: number;
  phase?: string | undefined;
  sha?: string | undefined;
  queueCount: number;
  pid?: number | undefined;
  lastError?: string;
  nextAction: string;
};
export function eligibleIssues(api: GitHubTransport): number[] {
  const result: number[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = api.get(
      `/repos/${repo}/issues?state=open&labels=agent%3Aapproved&per_page=100&page=${page}`,
    ) as {
      number?: number;
      pull_request?: unknown;
      labels?: { name: string }[];
    }[];
    if (!Array.isArray(rows)) throw new Error('Invalid issue listing');
    for (const row of rows)
      if (
        Number.isSafeInteger(row.number) &&
        !row.pull_request &&
        row.labels?.some((x) => x.name === 'agent:approved') &&
        !row.labels.some((x) => x.name === 'agent:blocked')
      )
        result.push(row.number!);
    if (rows.length < 100) return [...new Set(result)].sort((a, b) => a - b);
  }
  throw new Error('Issue listing exceeds verified page bound');
}
export function safeTaskDisposition(
  state: TaskState | undefined,
): 'new' | 'resume' | 'done' | 'blocked' {
  if (!state) return 'new';
  if (state.inFlight || state.pendingReport) return 'blocked';
  // The supervised pilot deliberately records a BLOCKED CI transition after
  // publishing the Draft PR. That is its successful, Owner-held terminal
  // boundary, not an invitation to reconcile or start CI automatically.
  if (
    ['DONE', 'READY_FOR_OWNER_REVIEW'].includes(state.phase) ||
    (state.phase === 'BLOCKED' &&
      !!state.prNumber &&
      !!state.headSha &&
      state.verdicts.IMPLEMENTATION?.verdict === 'PASS' &&
      state.verdicts.REVIEW?.verdict === 'PASS' &&
      state.verdicts.QA?.verdict === 'PASS' &&
      state.transitions.at(-1)?.errorCode === 'PILOT_END_BEFORE_CI')
  )
    return 'done';
  if (state.phase === 'BLOCKED') return 'blocked';
  return 'resume';
}
/** A checkpoint can be resumed only after its exact receipt is independently verified. */
export function recoverableCheckpoint(
  issue: number,
  state: TaskState,
): boolean {
  const pending = state.inFlight ?? state.pendingReport;
  if (!pending || !['IMPLEMENTATION', 'REVIEW', 'QA'].includes(pending.gate))
    return false;
  try {
    const p = paths(issue);
    const config = loadConfig(p.config);
    if (
      config.issue !== issue ||
      config.stateFile !== p.state ||
      config.evidenceDir !== p.evidence
    )
      return false;
    const key = `${issue}:${state.attempt}:${pending.gate}:${state.headSha ?? state.baseSha}:${state.candidateSha ?? '-'}`;
    if (pending.key !== key) return false;
    const receipt = JSON.parse(
      privateFile(
        join(
          p.evidence,
          `${createHash('sha256').update(key).digest('hex')}.json`,
        ),
      ),
    ) as Receipt;
    const evidence = verifyReceipt(config, state, pending.gate, key, receipt);
    return (
      !state.pendingReport ||
      JSON.stringify(state.pendingReport.evidence) === JSON.stringify(evidence)
    );
  } catch {
    return false;
  }
}
function privateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Unsafe private file');
  return readFileSync(path, 'utf8');
}
function saveStatus(status: QueueStatus): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(status), { mode: 0o600 });
  renameSync(temp, statusPath);
}
function reservationIssue(): number | undefined {
  if (!existsSync(launchPath)) return undefined;
  const value = JSON.parse(privateFile(launchPath)) as {
    issue?: number;
    session?: string;
    token?: string;
  };
  if (
    !Number.isSafeInteger(value.issue) ||
    value.session !== `fair-task-${value.issue}` ||
    !/^[a-f0-9]{64}$/.test(value.token ?? '')
  )
    throw new Error('Invalid launch reservation');
  return value.issue;
}
/** Allow a short asynchronous tmux handoff without claiming a model is live. */
export function pendingLaunchStatus(ageMs: number): QueueStatus['status'] {
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 45_000
    ? 'STARTING'
    : 'BLOCKED_RECONCILIATION';
}
function currentHandoffStatus(): QueueStatus['status'] {
  try {
    return pendingLaunchStatus(Date.now() - lstatSync(launchPath).mtimeMs);
  } catch {
    return 'BLOCKED_RECONCILIATION';
  }
}
/** Verify the real child Node runner, not just a tmux pane shell. */
export function matchesSupervisedRunnerArguments(
  args: string[],
  issue: number,
  token: string,
): boolean {
  return (
    Number.isSafeInteger(issue) &&
    /^[a-f0-9]{64}$/.test(token) &&
    args.length >= 5 &&
    args[1]?.endsWith('/scripts/orchestrator/dist/supervised.js') === true &&
    args[2] === 'run' &&
    args[3] === String(issue) &&
    args[4] === token
  );
}
function liveRunner(issue: number): number | undefined {
  const session = `fair-task-${issue}`;
  const result = spawnSync(
    '/usr/bin/tmux',
    [
      'display-message',
      '-p',
      '-t',
      `=${session}:runner`,
      '#{session_name} #{window_name} #{pane_pid}',
    ],
    { encoding: 'utf8' },
  );
  const match = new RegExp(`^${session} runner ([1-9][0-9]*)$`).exec(
    result.stdout?.trim() ?? '',
  );
  const panePid = Number(match?.[1]);
  if (result.status !== 0 || !Number.isSafeInteger(panePid) || panePid < 2)
    return undefined;
  try {
    const pidFile = join(root, 'tasks', String(issue), 'runner.pid');
    const stat = lstatSync(pidFile);
    if (!stat.isFile() || stat.uid !== process.getuid?.())
      return undefined;
    if (readFileSync(pidFile, 'utf8').trim() !== String(panePid))
      return undefined;
    const reservation = JSON.parse(privateFile(launchPath)) as {
      issue?: number;
      session?: string;
      token?: string;
    };
    if (
      reservation.issue !== issue ||
      reservation.session !== session ||
      !/^[a-f0-9]{64}$/.test(reservation.token ?? '')
    )
      return undefined;
    const procFile = `/proc/${panePid}/task/${panePid}/children`;
    const children = readFileSync(procFile, 'utf8').trim().split(/\s+/);
    for (const item of children) {
      const childPid = Number(item);
      if (!Number.isSafeInteger(childPid) || childPid < 2) continue;
      try {
        const cmdline = readFileSync(`/proc/${childPid}/cmdline`, 'utf8');
        const args = cmdline.split('\0').filter(Boolean);
        if (matchesSupervisedRunnerArguments(args, issue, reservation.token!))
          return childPid;
      } catch {
        // A process may have already exited. Never claim a stale PID.
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
/**
 * Deterministic, side-effect-free queue selection. Keep authorization and
 * receipt identity checks in injected guards so a second candidate can be
 * selected without resetting or rerunning an incomplete earlier task.
 */
export function selectEligibleQueueTask(
  numbers: number[],
  developmentSha: string,
  readState: (issue: number) => TaskState | undefined,
  checkApproval: (issue: number) => { specSha: string; baseSha: string },
  receiptVerified: (issue: number, state: TaskState) => boolean,
): {
  issue?: number;
  state?: TaskState | undefined;
  blocked: boolean;
  reconciliation: boolean;
  completed: boolean;
} {
  let blocked = false;
  let reconciliation = false;
  let completed = false;
  for (const issue of numbers) {
    let state: TaskState | undefined;
    try {
      state = readState(issue);
    } catch {
      reconciliation = true;
      continue;
    }
    const disposition = safeTaskDisposition(state);
    if (disposition === 'done') {
      completed = true;
      continue;
    }
    if (
      disposition === 'blocked' &&
      (!state || state.phase === 'BLOCKED' || !receiptVerified(issue, state))
    ) {
      reconciliation = true;
      continue;
    }
    try {
      const approved = checkApproval(issue);
      if (
        approved.baseSha !== developmentSha ||
        (state &&
          (state.specSha !== approved.specSha ||
            state.baseSha !== approved.baseSha))
      ) {
        blocked = true;
        continue;
      }
      return { issue, state, blocked, reconciliation, completed };
    } catch {
      blocked = true;
    }
  }
  return { blocked, reconciliation, completed };
}
export function queueStep(
  api: GitHubTransport,
  run: (issue: number) => void,
  developmentSha: string,
): QueueStatus {
  const numbers = eligibleIssues(api);
  const reserved = reservationIssue();
  if (reserved !== undefined) {
    const pid = liveRunner(reserved);
    const state = new StateStore(paths(reserved).state).load();
    if (pid)
      return {
        status: 'RUNNING',
        issue: reserved,
        pid,
        phase: state?.phase,
        sha: state?.headSha,
        queueCount: numbers.length,
        nextAction: 'Wait for verified runner',
      };
    const handoff = currentHandoffStatus();
    return {
      status: handoff,
      issue: reserved,
      phase: state?.phase,
      sha: state?.headSha,
      queueCount: numbers.length,
      ...(handoff === 'STARTING' ? {} : { lastError: 'STALE_RESERVATION' }),
      nextAction:
        handoff === 'STARTING'
          ? 'Await verified tmux runner identity'
          : 'Owner must adjudicate reservation and exact receipt before clearing it',
    };
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(lockPath))
    writeFileSync(lockPath, '', { flag: 'wx', mode: 0o600 });
  privateFile(lockPath);
  const lock = spawnSync(
    '/usr/bin/flock',
    ['-n', '-E', '75', lockPath, '/usr/bin/true'],
    { stdio: 'ignore' },
  );
  if (lock.status === 75)
    return {
      status: 'BLOCKED_RECONCILIATION',
      queueCount: numbers.length,
      lastError: 'UNIDENTIFIED_LOCK_HOLDER',
      nextAction: 'Identify global lock holder before admission',
    };
  if (lock.status !== 0)
    return {
      status: 'BLOCKED_RECONCILIATION',
      queueCount: numbers.length,
      lastError: 'LOCK_PROBE_FAILED',
      nextAction: 'Inspect global lock',
    };
  const selection = selectEligibleQueueTask(
    numbers,
    developmentSha,
    (issue) => new StateStore(paths(issue).state).load(),
    (issue) => approvedIssue(api, issue, owner, true),
    (issue, state) => recoverableCheckpoint(issue, state),
  );
  const { issue, state, blocked, reconciliation, completed } = selection;
  if (issue !== undefined) {
    try {
      const approved = approvedIssue(api, issue, owner, true);
      const issueDetails = api.get(`/repos/${repo}/issues/${issue}`) as {
        body?: string;
      };
      const specCommit = /^Pilot spec commit SHA: ([a-f0-9]{40})$/m.exec(
        issueDetails.body ?? '',
      );
      if (!specCommit) throw new Error('Missing pinned spec commit');
      syncApprovedSpec(
        process.cwd(),
        specCommit[1]!,
        approved.specPath,
        approved.specSha,
      );
    } catch {
      return {
        status: 'BLOCKED_APPROVAL',
        issue,
        phase: state?.phase ?? 'QUEUED',
        sha: state?.headSha,
        queueCount: numbers.length,
        lastError: 'APPROVED_SPEC_SYNC_FAILED',
        nextAction: 'Verify immutable spec commit, blob and Git connectivity',
      };
    }
    try {
      run(issue);
    } catch {
      return {
        status: 'BLOCKED_RECONCILIATION',
        issue,
        phase: state?.phase ?? 'QUEUED',
        sha: state?.headSha,
        queueCount: numbers.length,
        lastError: 'SUPERVISED_LAUNCH_REFUSED',
        nextAction: 'Inspect admission failure without replaying a model gate',
      };
    }
    const pid = liveRunner(issue);
    if (!pid) {
      const handoff = currentHandoffStatus();
      return {
        status: handoff,
        issue,
        phase: state?.phase ?? 'QUEUED',
        sha: state?.headSha,
        queueCount: numbers.length,
        ...(handoff === 'STARTING'
          ? {}
          : { lastError: 'LAUNCH_IDENTITY_UNVERIFIED' }),
        nextAction:
          handoff === 'STARTING'
            ? 'Await verified tmux runner identity'
            : 'Inspect reserved runner identity',
      };
    }
    return {
      status: 'RUNNING',
      issue,
      pid,
      phase: state?.phase ?? 'QUEUED',
      sha: state?.headSha,
      queueCount: numbers.length,
      nextAction: 'Observe reserved tmux runner',
    };
  }
  return {
    status: reconciliation
      ? 'BLOCKED_RECONCILIATION'
      : blocked
        ? 'BLOCKED_APPROVAL'
        : completed
          ? 'DONE'
          : 'IDLE',
    queueCount: numbers.length,
    nextAction: reconciliation
      ? 'Inspect exact task receipt and reservation'
      : blocked
        ? 'Inspect pinned approvals and task state'
        : 'Wait for new approved issue',
  };
}
function gh(): GhTransport {
  const token = privateFile(tokenPath).trim();
  const which = spawnSync('/usr/bin/which', ['gh'], { encoding: 'utf8' });
  if (which.status !== 0) throw new Error('GitHub CLI unavailable');
  return new GhTransport(token, which.stdout.trim());
}
function development(api: GitHubTransport): string {
  const ref = api.get(`/repos/${repo}/git/ref/heads/development`) as {
    object?: { sha?: string };
  };
  if (!/^[a-f0-9]{40}$/.test(ref.object?.sha ?? ''))
    throw new Error('Invalid development ref');
  return ref.object!.sha!;
}
/**
 * Refresh only the remote-tracking development ref. Never checkout/reset the
 * source tree or rebase a task. The remote GitHub API identity is checked
 * against the fetched Git object before any admission.
 */
export function syncApprovedDevelopment(
  sourceRepo: string,
  remoteSha: string,
): void {
  if (!/^[a-f0-9]{40}$/.test(remoteSha))
    throw new Error('Invalid remote development SHA');
  const git = (args: string[]) =>
    spawnSync('/usr/bin/git', ['-C', sourceRepo, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  const base = git(['rev-parse', '--show-toplevel']);
  if (base.status !== 0 || base.stdout.trim() !== resolve(sourceRepo))
    throw new Error('Queue source repository identity mismatch');
  const fetch = git([
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    '+refs/heads/development:refs/remotes/origin/development',
  ]);
  if (fetch.status !== 0) throw new Error('QUEUE_DEVELOPMENT_FETCH_FAILED');
  const local = git(['rev-parse', 'refs/remotes/origin/development']);
  if (local.status !== 0 || local.stdout.trim() !== remoteSha)
    throw new Error('QUEUE_DEVELOPMENT_IDENTITY_MISMATCH');
}
/**
 * The approved immutable specification can live on a separate branch.
 * Fetch just its pinned commit when missing, and verify the pinned blob.
 * No source checkout, task state or worktree is modified.
 */
export function syncApprovedSpec(
  sourceRepo: string,
  commitSha: string,
  specPath: string,
  specSha: string,
): void {
  if (
    !/^[a-f0-9]{40}$/.test(commitSha) ||
    !/^[a-f0-9]{40}$/.test(specSha) ||
    !/^docs\/tasks\/[\w-]+\.md$/.test(specPath)
  )
    throw new Error('Invalid pinned specification identity');
  const git = (args: string[]) =>
    spawnSync('/usr/bin/git', ['-C', sourceRepo, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  if (git(['cat-file', '-e', `${commitSha}^{commit}`]).status !== 0) {
    const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', commitSha]);
    if (fetched.status !== 0) throw new Error('QUEUE_SPEC_FETCH_FAILED');
  }
  const result = git(['rev-parse', `${commitSha}:${specPath}`]);
  if (result.status !== 0 || result.stdout.trim() !== specSha)
    throw new Error('QUEUE_SPEC_IDENTITY_MISMATCH');
}
function main(): void {
  const command = process.argv[2];
  if (command === 'status') {
    const status: QueueStatus = existsSync(statusPath)
      ? (JSON.parse(privateFile(statusPath)) as QueueStatus)
      : { status: 'IDLE', queueCount: 0, nextAction: 'Enable queue service' };
    if (status.status === 'RUNNING') {
      const reserved = reservationIssue();
      const pid =
        status.issue && reserved === status.issue
          ? liveRunner(status.issue)
          : undefined;
      if (!pid) {
        status.status = currentHandoffStatus();
        if (status.status === 'STARTING') delete status.lastError;
        else status.lastError = 'RUNNER_IDENTITY_UNVERIFIED';
        status.nextAction =
          status.status === 'STARTING'
            ? 'Await verified tmux runner identity'
            : 'Inspect saved task and reservation';
        delete status.pid;
      } else status.pid = pid;
    }
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (command === 'worker') {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(workerLockPath))
      writeFileSync(workerLockPath, '', { flag: 'wx', mode: 0o600 });
    privateFile(workerLockPath);
    const child = spawnSync(
      '/usr/bin/flock',
      [
        '-n',
        workerLockPath,
        process.execPath,
        process.argv[1]!,
        'internal-worker',
      ],
      { stdio: 'inherit' },
    );
    if (child.status !== 0) process.exitCode = child.status ?? 1;
    return;
  }
  if (command !== 'internal-worker')
    throw new Error('Usage: queue.js worker|status');
  // A direct internal invocation cannot claim an existing worker's lock.
  const probe = spawnSync(
    '/usr/bin/flock',
    ['-n', '-E', '75', workerLockPath, '/usr/bin/true'],
    { stdio: 'ignore' },
  );
  if (probe.status !== 75)
    throw new Error('Queue worker requires its exclusive lock');
  const parentArgs = readFileSync(
    `/proc/${process.ppid}/cmdline`,
    'utf8',
  ).split('\0');
  if (
    parentArgs[0] !== '/usr/bin/flock' ||
    parentArgs[1] !== '-n' ||
    parentArgs[2] !== workerLockPath ||
    parentArgs[3] !== process.execPath ||
    parentArgs[4] !== process.argv[1] ||
    parentArgs[5] !== 'internal-worker'
  )
    throw new Error('Queue worker lock holder identity is unverified');
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  const tick = () => {
    try {
      const api = gh();
      const currentDevelopment = development(api);
      syncApprovedDevelopment(process.cwd(), currentDevelopment);
      const status = queueStep(
        api,
        (issue) => {
          const child = spawnSync(
            process.execPath,
            [
              resolve('scripts/orchestrator/dist/supervised.js'),
              'start',
              String(issue),
            ],
            { stdio: 'ignore' },
          );
          if (child.status !== 0) throw new Error('Supervised launch refused');
        },
        currentDevelopment,
      );
      saveStatus(status);
    } catch {
      saveStatus({
        status: 'BLOCKED_RECONCILIATION',
        queueCount: 0,
        lastError: 'QUEUE_POLL_FAILED',
        nextAction: 'Inspect private service journal and GitHub connectivity',
      });
    }
    if (!stopping) setTimeout(tick, 30_000);
  };
  tick();
}
if (process.argv[1]?.endsWith('/queue.js')) main();

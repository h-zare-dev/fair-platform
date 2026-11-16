import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { approvedIssue, GhTransport } from './github.js';
import { runPilot } from './pilot.js';
import { loadConfig } from './runner.js';
import { StateStore, type TaskState } from './state.js';

const git = '/usr/bin/git';
const home = homedir();
const sourceRepo = join(home, 'Work/fair-platform-status');
const tasksRoot = join(home, 'Work/fair-agent-tasks');
const configRoot = join(home, '.config/fair-platform/tasks');
const stateRoot = join(home, '.local/state/fair-platform/tasks');
const lockPath = join(home, '.local/state/fair-platform/supervised.lock');
const launchPath = join(home, '.local/state/fair-platform/supervised.launch');
const tokenPath = join(home, '.local/share/fair-platform/github-token');
const modelPath = join(home, '.local/bin/fair-agent-models.conf');

export function parseCommand(args: string[]): {
  command: string;
  issue: number;
} {
  if (
    args.length !== 2 ||
    !['preflight', 'prepare', 'run', 'tmux', 'start'].includes(args[0]!) ||
    !/^[1-9][0-9]*$/.test(args[1]!)
  )
    throw new Error(
      'Usage: supervised <start|preflight|prepare|run|tmux> <positive-issue-number>',
    );
  const issue = Number(args[1]);
  if (!Number.isSafeInteger(issue) || issue === 57)
    throw new Error('Unsafe or reserved issue number');
  return { command: args[0]!, issue };
}
function privatePath(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(`Unsafe private file: ${path}`);
}
function safeDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(`Unsafe private directory: ${path}`);
}
function gitOutput(args: string[]): string {
  return execFileSync(git, ['-C', sourceRepo, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();
}
export function paths(issue: number) {
  const task = join(tasksRoot, String(issue));
  const state = join(stateRoot, String(issue));
  return {
    config: join(configRoot, `${issue}.json`),
    state: join(state, 'state.json'),
    evidence: join(state, 'evidence'),
    worktrees: {
      IMPLEMENTATION: join(task, 'fair-agent-implementation'),
      REVIEW: join(task, 'fair-agent-review'),
      QA: join(task, 'fair-agent-qa'),
    },
    candidate: join(task, 'fair-agent-candidate'),
  };
}
function approval(issue: number): TaskState {
  privatePath(tokenPath);
  const token = readFileSync(tokenPath, 'utf8').trim();
  const gh = execFileSync('/usr/bin/which', ['gh'], {
    encoding: 'utf8',
  }).trim();
  const approved = approvedIssue(
    new GhTransport(token, gh),
    issue,
    'h-zare-dev',
    true,
  );
  const remote = JSON.parse(
    execFileSync(
      gh,
      ['api', 'repos/h-zare-dev/fair-platform/git/ref/heads/development'],
      {
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token },
        timeout: 20_000,
      },
    ),
  ) as { object?: { sha?: string } };
  if (
    remote.object?.sha !== approved.baseSha ||
    gitOutput(['rev-parse', 'refs/remotes/origin/development']) !==
      approved.baseSha
  )
    throw new Error(
      'Approved development base drifted; fetch origin/development and obtain fresh approval',
    );
  try {
    gitOutput(['cat-file', '-e', `${approved.specSha}^{blob}`]);
  } catch {
    throw new Error(
      `Approved spec blob ${approved.specSha} missing locally; fetch the immutable approved spec branch into ${sourceRepo}`,
    );
  }
  return approved;
}
/**
 * Clean independent worktrees are reusable across implementation reworks:
 * gate.ts will switch them to the exact new HEAD immediately before model
 * execution. Never accept a stale worktree for an already in-flight gate.
 */
export function allowsIdleRoleRefresh(
  state: TaskState | undefined,
  role: string,
): boolean {
  return (
    (role === 'REVIEW' || role === 'QA') &&
    !!state &&
    !state.inFlight &&
    !state.pendingReport &&
    !!state.headSha
  );
}

export function ensurePrivateLockFile(path: string): void {
  safeDir(dirname(path));
  if (!existsSync(path)) {
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
  }
  privatePath(path);
}
type LaunchReservation = { issue: number; token: string; session: string };
export function assertLaunchReservation(
  command: string,
  issue: number,
  reserved: LaunchReservation,
  token?: string,
): void {
  if (
    command !== 'run' ||
    reserved.issue !== issue ||
    !token ||
    !/^[0-9a-f]{64}$/.test(reserved.token) ||
    !/^[0-9a-f]{64}$/.test(token) ||
    !timingSafeEqual(
      Buffer.from(reserved.token, 'hex'),
      Buffer.from(token, 'hex'),
    ) ||
    reserved.session !== `fair-task-${issue}`
  )
    throw new Error('A supervised launch is pending; manual recovery required');
}

/** Verify that the flocked runner descends from the reserved tmux pane. */
export function verifyLaunchHandoff(
  reserved: LaunchReservation,
  token?: string,
): void {
  assertLaunchReservation('run', reserved.issue, reserved, token);
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%[0-9]+$/.test(pane))
    throw new Error('Reserved launch requires its tmux runner pane');
  const result = spawnSync(
    '/usr/bin/tmux',
    [
      'display-message',
      '-p',
      '-t',
      pane,
      '#{session_name} #{window_name} #{pane_pid}',
    ],
    { encoding: 'utf8' },
  );
  const match = /^(\S+) runner ([1-9][0-9]*)$/.exec(
    result.stdout?.trim() ?? '',
  );
  if (result.status !== 0 || !match || match[1] !== reserved.session)
    throw new Error('Reserved launch requires its tmux runner pane');
  const panePid = Number(match[2]);
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    if (pid === panePid) return;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parent = /^\d+ \(.+\) \S+ (\d+) /.exec(stat);
    if (!parent) break;
    pid = Number(parent[1]);
  }
  throw new Error('Reserved launch is not owned by its tmux runner pane');
}

export function allowsInterruptedImplementation(
  state: TaskState | undefined,
  role: string,
): boolean {
  return (
    role === 'IMPLEMENTATION' && state?.inFlight?.gate === 'IMPLEMENTATION'
  );
}
function checkExisting(issue: number, approved: TaskState): void {
  const p = paths(issue);
  if (existsSync(p.state)) privatePath(p.state);
  const state = new StateStore(p.state).load();
  if (existsSync(p.config)) {
    privatePath(p.config);
    const identity = JSON.parse(readFileSync(p.config, 'utf8')) as {
      approvedSpecSha?: string;
      approvedBaseSha?: string;
      issue?: number;
    };
    if (
      identity.issue !== issue ||
      identity.approvedSpecSha !== approved.specSha ||
      identity.approvedBaseSha !== approved.baseSha
    )
      throw new Error('Existing config differs from pinned approval');
  }
  if (
    state &&
    (state.taskId !== issue ||
      state.specSha !== approved.specSha ||
      state.baseSha !== approved.baseSha ||
      state.specPath !== approved.specPath)
  )
    throw new Error('Existing task state differs from pinned approval');
  if (
    state &&
    ['DONE', 'BLOCKED', 'READY_FOR_OWNER_REVIEW'].includes(state.phase)
  )
    throw new Error('Existing terminal task cannot resume');
  // The engine verifies the immutable receipt before resuming an in-flight
  // gate, and resumes pending publication without calling a model again.
  if (state && !existsSync(p.config))
    throw new Error('Task state exists without its pinned config');
  if (state?.headSha && !existsSync(p.worktrees.IMPLEMENTATION))
    throw new Error('Implementation worktree is missing');
  if (existsSync(p.evidence)) {
    if (!state) throw new Error('Unexpected evidence without task state');
    safeExistingDir(p.evidence);
  } else if (state && Object.keys(state.verdicts).length)
    throw new Error('Task evidence directory is missing');
  for (const [role, path] of Object.entries(p.worktrees)) {
    if (!existsSync(path)) continue;
    if (!state) throw new Error(`Unexpected existing ${role} worktree`);
    const top = execFileSync(
      git,
      ['-C', path, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    ).trim();
    if (top !== path) throw new Error(`Unsafe ${role} worktree`);
    const dirty = execFileSync(git, ['-C', path, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    // An interrupted model may leave edits behind. Let the engine inspect its
    // immutable receipt and fail closed if the execution is unverified.
    if (dirty && !allowsInterruptedImplementation(state, role))
      throw new Error(`Unsafe or dirty ${role} worktree`);
    const head = execFileSync(git, ['-C', path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (
      head !==
        (role === 'IMPLEMENTATION'
          ? (state.headSha ?? state.baseSha)
          : state.headSha) &&
      !allowsInterruptedImplementation(state, role) &&
      !allowsIdleRoleRefresh(state, role)
    )
      throw new Error(`Divergent ${role} worktree`);
  }
  if (existsSync(p.candidate)) throw new Error('Unexpected candidate worktree');
  const branch = `refs/heads/agent/${issue}-${approved.specSha.slice(0, 12)}`;
  const branchExists =
    spawnSync(git, [
      '-C',
      sourceRepo,
      'show-ref',
      '--quiet',
      '--verify',
      branch,
    ]).status === 0;
  if (branchExists && !state) throw new Error('Unexpected task branch');
  if (state?.headSha && !branchExists)
    throw new Error('Task branch is missing');
}
function safeExistingDir(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(`Unsafe private directory: ${path}`);
}
function prepare(issue: number, approved: TaskState): void {
  const p = paths(issue);
  checkExisting(issue, approved);
  if (existsSync(p.config)) {
    privatePath(p.config);
    const config = loadConfig(p.config);
    if (
      config.issue !== issue ||
      config.ownerLogin !== 'h-zare-dev' ||
      config.modelFile !== modelPath ||
      config.githubTokenFile !== tokenPath ||
      config.candidateWorktree !== p.candidate ||
      JSON.stringify(config.worktrees) !== JSON.stringify(p.worktrees) ||
      config.stateFile !== p.state ||
      config.evidenceDir !== p.evidence ||
      config.sourceRepo !== sourceRepo ||
      config.pilotMode !== true ||
      config.maxModelCallsPerDay > 6 ||
      config.labActivated !== false ||
      Object.keys(config.commands).sort().join(',') !==
        'IMPLEMENTATION,QA,REVIEW' ||
      (['IMPLEMENTATION', 'REVIEW', 'QA'] as const).some(
        (role) =>
          config.commands[role]?.executable !== resolve(process.execPath) ||
          JSON.stringify(config.commands[role]?.args) !==
            JSON.stringify([
              resolve('scripts/orchestrator/dist/gate.js'),
              role,
            ]),
      )
    )
      throw new Error('Existing config does not match this supervised task');
    return;
  }
  safeDir(dirname(configRoot));
  safeDir(configRoot);
  safeDir(dirname(stateRoot));
  safeDir(stateRoot);
  const node = resolve(process.execPath);
  const gate = resolve('scripts/orchestrator/dist/gate.js');
  if (!existsSync(gate))
    throw new Error('Compile orchestrator TypeScript before prepare');
  const which = (name: string) =>
    execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
  privatePath(modelPath);
  privatePath(tokenPath);
  const command = (role: string) => ({
    executable: node,
    args: [gate, role],
    timeoutMs: 3_600_000,
  });
  const config = {
    issue,
    approvedSpecSha: approved.specSha,
    approvedBaseSha: approved.baseSha,
    ownerLogin: 'h-zare-dev',
    pilotMode: true,
    labActivated: false,
    stateFile: p.state,
    evidenceDir: p.evidence,
    modelFile: modelPath,
    githubTokenFile: tokenPath,
    sourceRepo,
    candidateWorktree: p.candidate,
    worktrees: p.worktrees,
    pnpmExecutable: which('pnpm'),
    codexExecutable: which('codex'),
    ghExecutable: which('gh'),
    maxModelCallsPerDay: 6,
    commands: {
      IMPLEMENTATION: command('IMPLEMENTATION'),
      REVIEW: command('REVIEW'),
      QA: command('QA'),
    },
  };
  const fd = openSync(p.config, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}
/**
 * Environment variables are not a locking mechanism. An internal invocation
 * must be a child of the actual flock wrapper and the OS lock must be held.
 * This prevents a trivial FAIR_SUPERVISED_LOCKED=1 bypass.
 */
export function verifyInternalLock(): void {
  if (process.env.FAIR_SUPERVISED_LOCKED !== '1' || !existsSync(lockPath))
    throw new Error('Internal command requires the supervised lock');
  privatePath(lockPath);
  let parentArgv: string[];
  try {
    parentArgv = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean);
  } catch {
    throw new Error('Internal command cannot verify flock parent');
  }
  if (
    basename(parentArgv[0] ?? '') !== 'flock' ||
    !parentArgv.includes(lockPath)
  )
    throw new Error('Internal command requires the supervised lock');
  const probe = spawnSync(
    '/usr/bin/flock',
    ['-n', '-E', '75', lockPath, '/usr/bin/true'],
    { stdio: 'ignore' },
  );
  if (probe.status !== 75)
    throw new Error('Internal command requires the supervised lock');
}

function locked(command: string, issue: number, token?: string): void {
  ensurePrivateLockFile(lockPath);
  const result = spawnSync(
    '/usr/bin/flock',
    [
      '-n',
      lockPath,
      process.execPath,
      resolve('scripts/orchestrator/dist/supervised.js'),
      `internal-${command}`,
      String(issue),
      ...(token ? [token] : []),
    ],
    { stdio: 'inherit', env: { ...process.env, FAIR_SUPERVISED_LOCKED: '1' } },
  );
  if (result.status !== 0)
    throw new Error(
      result.status === 1
        ? 'Another supervised task holds the global lock'
        : `Supervised ${command} failed`,
    );
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const internal = args[0]?.startsWith('internal-');
  if (internal) verifyInternalLock();
  const token = args[2];
  if (
    token &&
    (args.length !== 3 || !['run', 'internal-run'].includes(args[0]!))
  )
    throw new Error('Unexpected launch token');
  const { command, issue } = parseCommand(
    internal ? [args[0]!.slice(9), args[1]!] : args.slice(0, 2),
  );
  if (
    !internal &&
    args.length !== 2 &&
    !(command === 'run' && args.length === 3)
  )
    throw new Error('Unexpected launch token');
  if (!internal && command === 'start') {
    locked('start', issue);
    return;
  } else if (!internal) {
    locked(command, issue, token);
    return;
  }
  let reservation: LaunchReservation | undefined;
  if (existsSync(launchPath)) {
    privatePath(launchPath);
    try {
      reservation = JSON.parse(
        readFileSync(launchPath, 'utf8'),
      ) as LaunchReservation;
    } catch {
      throw new Error('Invalid launch reservation; manual recovery required');
    }
    assertLaunchReservation(command, issue, reservation, token);
    verifyLaunchHandoff(reservation, token);
  }
  const approved = approval(issue);
  if (command === 'preflight') {
    checkExisting(issue, approved);
    process.stdout.write(`PREFLIGHT_PASS #${issue}\n`);
    return;
  }
  if (command === 'prepare') {
    prepare(issue, approved);
    process.stdout.write(`PREPARED #${issue}\n`);
    return;
  }
  if (command === 'start') prepare(issue, approved);
  if (command === 'run') {
    checkExisting(issue, approved);
    const p = paths(issue);
    if (!existsSync(p.config)) throw new Error('Run prepare first');
    prepare(issue, approved);
    if (reservation) unlinkSync(launchPath);
    await runPilot(p.config);
    return;
  }
  checkExisting(issue, approved);
  prepareCheckForTmux(issue);
  if (command === 'start' || command === 'tmux') {
    reservation = {
      issue,
      token: randomBytes(32).toString('hex'),
      session: `fair-task-${issue}`,
    };
    const fd = openSync(launchPath, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(reservation)}\n`);
    } finally {
      closeSync(fd);
    }
  }
  const script = resolve('scripts/orchestrator/supervised-tmux.sh');
  const result = spawnSync(
    '/bin/bash',
    [
      script,
      String(issue),
      resolve('scripts/orchestrator/dist/supervised.js'),
      paths(issue).state,
      reservation!.token,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(
      'tmux launch refused; launch reservation retained for manual recovery',
    );
  }
}
function prepareCheckForTmux(issue: number): void {
  const config = paths(issue).config;
  if (!existsSync(config)) throw new Error('Run prepare first');
  privatePath(config);
}
if (/\/supervised\.(?:js|ts)$/.test(process.argv[1] ?? ''))
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });

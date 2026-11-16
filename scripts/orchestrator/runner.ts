import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  join,
  basename,
  dirname,
  resolve,
  relative,
  isAbsolute,
} from 'node:path';
import { Orchestrator, type Evidence, type Ports } from './engine.js';
import {
  approvedIssue,
  GhTransport,
  postVerdict,
  ensureDraftPr,
  verifyExactCi,
  verifyOwnerMerge,
} from './github.js';
import { publishHead } from './publish.js';
import { loadModelRoutes } from './models.js';
import { isSha, StateStore, type Gate } from './state.js';
import { verifyInternalLock } from './supervised.js';

type Command = { executable: string; args: string[]; timeoutMs: number };
type CommandGate = Exclude<Gate, 'CI'>;
type Config = {
  issue: number;
  ownerLogin: string;
  stateFile: string;
  modelFile: string;
  evidenceDir: string;
  maxModelCallsPerDay: number;
  worktrees: { IMPLEMENTATION: string; REVIEW: string; QA: string };
  sourceRepo: string;
  candidateWorktree: string;
  pnpmExecutable: string;
  codexExecutable: string;
  githubTokenFile: string;
  ghExecutable: string;
  labActivated: boolean;
  pilotMode?: boolean;
  commands: Partial<Record<CommandGate, Command>>;
};
const gates: CommandGate[] = [
  'IMPLEMENTATION',
  'REVIEW',
  'QA',
  'CANDIDATE',
  'LAB_DEPLOY',
  'LAB_E2E',
  'POST_MERGE',
];

export function loadConfig(path: string): Config {
  privateFile(path);
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  if (
    !Number.isSafeInteger(config.issue) ||
    config.issue < 1 ||
    !/^[a-zA-Z0-9-]+$/.test(config.ownerLogin) ||
    !config.stateFile.startsWith('/') ||
    !config.modelFile.startsWith('/') ||
    !config.evidenceDir.startsWith('/') ||
    !config.sourceRepo.startsWith('/') ||
    !config.candidateWorktree.startsWith('/') ||
    !config.pnpmExecutable.startsWith('/') ||
    !config.codexExecutable.startsWith('/') ||
    !config.githubTokenFile.startsWith('/') ||
    !config.ghExecutable.startsWith('/') ||
    config.labActivated !== false ||
    (config.pilotMode !== undefined && config.pilotMode !== true) ||
    !Number.isSafeInteger(config.maxModelCallsPerDay) ||
    config.maxModelCallsPerDay < 1 ||
    config.maxModelCallsPerDay > 50
  )
    throw new Error('Invalid runner configuration');
  privateFile(config.modelFile);
  privateFile(config.githubTokenFile);
  for (const role of ['IMPLEMENTATION', 'REVIEW', 'QA'] as const)
    if (
      !config.worktrees?.[role]?.startsWith('/') ||
      basename(config.worktrees[role]) !== `fair-agent-${role.toLowerCase()}` ||
      config.worktrees[role] === config.sourceRepo
    )
      throw new Error(`Unsafe ${role} worktree`);
  if (basename(config.candidateWorktree) !== 'fair-agent-candidate')
    throw new Error('Unsafe candidate worktree');
  if (new Set(Object.values(config.worktrees)).size !== 3)
    throw new Error('Role worktrees must be distinct');
  loadModelRoutes(config.modelFile);
  for (const gate of gates) {
    // Pilot deliberately cannot execute candidate, Lab or post-merge gates.
    // These gate commands are still mandatory in production mode.
    if (config.pilotMode && !['IMPLEMENTATION', 'REVIEW', 'QA'].includes(gate))
      continue;
    const command = config.commands?.[gate];
    if (
      !command?.executable.startsWith('/') ||
      !Array.isArray(command.args) ||
      command.args.some((arg) => typeof arg !== 'string') ||
      !Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1000 ||
      command.timeoutMs > 3_600_000
    )
      throw new Error(`Invalid ${gate} command`);
    const info = lstatSync(command.executable);
    if (
      !info.isFile() ||
      (info.mode & 0o022) !== 0 ||
      ![0, process.getuid?.()].includes(info.uid) ||
      (info.mode & 0o111) === 0
    )
      throw new Error(`Unsafe ${gate} executable`);
  }
  return config;
}

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error('Unsafe private configuration file');
}

export type Receipt = {
  key: string;
  gate: Gate;
  taskId: number;
  attempt: number;
  specSha: string;
  baseSha: string;
  headSha?: string | undefined;
  candidateSha?: string | undefined;
  evidence: Evidence;
};

export function receiptFor(
  state: Readonly<import('./state.js').TaskState>,
  gate: Gate,
  key: string,
  evidence: Evidence,
): Receipt {
  return {
    key,
    gate,
    taskId: state.taskId,
    attempt: state.attempt,
    specSha: state.specSha,
    baseSha: state.baseSha,
    headSha: state.headSha,
    candidateSha: state.candidateSha,
    evidence,
  };
}

function verifiedWorktreeHead(path: string): string {
  return execFileSync('/usr/bin/git', ['-C', path, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin' },
  }).trim();
}

export function verifyReceipt(
  config: Config,
  state: Readonly<import('./state.js').TaskState>,
  gate: Gate,
  key: string,
  receipt: Receipt,
): Evidence {
  const expected = receiptFor(state, gate, key, receipt.evidence);
  if (JSON.stringify(receipt) !== JSON.stringify(expected))
    throw new Error('Stale or untrusted gate recovery receipt');
  const evidence = receipt.evidence;
  if (
    !['PASS', 'FAIL', 'BLOCKED'].includes(evidence?.verdict) ||
    !isSha(evidence?.sha ?? '') ||
    !/^[a-zA-Z0-9_.:-]{1,120}$/.test(evidence?.evidenceId ?? '')
  )
    throw new Error('Invalid saved gate evidence');
  if (gate === 'IMPLEMENTATION' && evidence.verdict === 'PASS') {
    if (verifiedWorktreeHead(config.worktrees.IMPLEMENTATION) !== evidence.sha)
      throw new Error('Implementation result no longer matches worktree HEAD');
  } else if (gate === 'REVIEW' || gate === 'QA') {
    if (
      evidence.sha !== state.headSha ||
      verifiedWorktreeHead(config.worktrees[gate]) !== state.headSha
    )
      throw new Error('Independent gate result no longer matches HEAD');
  } else if (gate === 'CANDIDATE') {
    if (
      evidence.sha !== state.headSha ||
      (evidence.verdict === 'PASS' &&
        (!isSha(evidence.candidateSha ?? '') ||
          verifiedWorktreeHead(config.candidateWorktree) !==
            evidence.candidateSha))
    )
      throw new Error('Candidate result is stale');
  } else {
    // Lab and post-merge side effects require remote reconciliation and
    // must not be trusted from a local file until these gates are built.
    throw new Error('Remote gate recovery requires independent verification');
  }
  return evidence;
}

/**
 * An Implementation model can have committed, written its receipt, and
 * published a newer HEAD before the runner persisted its checkpoint.
 * Trust only the exact saved receipt, current worktree HEAD and gate key.
 * This permits safe replay of publication, never replay of the model call.
 */
export function isReceiptProvenPublishedHead(
  config: Config,
  state: Readonly<import('./state.js').TaskState>,
  remoteSha: string,
): boolean {
  const flight = state.inFlight;
  const expectedKey = `${state.taskId}:${state.attempt}:IMPLEMENTATION:${state.headSha ?? state.baseSha}:${state.candidateSha ?? '-'}`;
  if (
    state.phase !== 'IMPLEMENTING' ||
    flight?.gate !== 'IMPLEMENTATION' ||
    flight.key !== expectedKey ||
    !isSha(remoteSha)
  )
    return false;
  const path = join(
    config.evidenceDir,
    `${createHash('sha256').update(expectedKey).digest('hex')}.json`,
  );
  let receipt: Receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const evidence = verifyReceipt(
    config,
    state,
    'IMPLEMENTATION',
    expectedKey,
    receipt,
  );
  return evidence.verdict === 'PASS' && evidence.sha === remoteSha;
}

/**
 * Read-only capacity check before a gate is recorded as in-flight. The actual
 * daily usage reservation still happens in run(), under the task lock.
 */
export function assertModelCallCapacity(
  evidenceDir: string,
  maxModelCallsPerDay: number,
  day = new Date().toISOString().slice(0, 10),
): void {
  const usagePath = join(evidenceDir, 'usage.json');
  let usage: Record<string, number> = {};
  try {
    usage = JSON.parse(readFileSync(usagePath, 'utf8')) as Record<
      string,
      number
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if ((usage[day] ?? 0) >= maxModelCallsPerDay)
    throw new Error('Daily model call budget exhausted');
}

export function commandPorts(config: Config): Ports {
  const token = readFileSync(config.githubTokenFile, 'utf8').trim();
  const api = new GhTransport(token, config.ghExecutable);
  const branch = `agent/${config.issue}-`;
  return {
    preflightRun(gate) {
      if (gate === 'IMPLEMENTATION' || gate === 'REVIEW' || gate === 'QA')
        assertModelCallCapacity(config.evidenceDir, config.maxModelCallsPerDay);
      return Promise.resolve();
    },
    reconcile(state) {
      const current = approvedIssue(
        api,
        state.taskId,
        config.ownerLogin,
        config.pilotMode === true,
      );
      if (
        current.specSha !== state.specSha ||
        current.baseSha !== state.baseSha
      )
        throw new Error('Approved task changed after checkpoint');
      if (state.prNumber && state.headSha) {
        const pr = api.get(
          `/repos/h-zare-dev/fair-platform/pulls/${state.prNumber}`,
        ) as {
          head?: { sha?: string };
          base?: { ref?: string };
          draft?: boolean;
          merged?: boolean;
        };
        if (
          pr.base?.ref !== 'development' ||
          (!pr.draft && !pr.merged) ||
          (pr.head?.sha !== state.headSha &&
            !isReceiptProvenPublishedHead(config, state, pr.head?.sha ?? ''))
        )
          throw new Error('PR head/base/draft state drifted');
      }
      return Promise.resolve();
    },
    developmentSha() {
      const ref = api.get(
        '/repos/h-zare-dev/fair-platform/git/ref/heads/development',
      ) as { object?: { sha?: string } };
      const sha = ref.object?.sha;
      if (!sha || !isSha(sha)) throw new Error('Cannot verify development SHA');
      return Promise.resolve(sha);
    },
    publish(state) {
      const name = `${branch}${state.specSha.slice(0, 12)}`;
      publishHead(config.worktrees.IMPLEMENTATION, name, state.headSha!, token);
      state.prNumber = ensureDraftPr(api, state, name);
      return Promise.resolve();
    },
    verifyOwnerMerge(state) {
      if (!state.prNumber || !state.headSha) return Promise.resolve(undefined);
      const pr = api.get(
        `/repos/h-zare-dev/fair-platform/pulls/${state.prNumber}`,
      ) as { merged?: boolean };
      if (!pr.merged) return Promise.resolve(undefined);
      const development = (
        api.get(
          '/repos/h-zare-dev/fair-platform/git/ref/heads/development',
        ) as { object: { sha: string } }
      ).object.sha;
      return Promise.resolve(
        verifyOwnerMerge(
          api,
          state.prNumber,
          config.ownerLogin,
          state.headSha,
          development,
          state.baseSha,
        ),
      );
    },
    run(gate, state, key) {
      if (gate === 'CI') {
        if (config.pilotMode) {
          // The pilot cannot turn a green or red CI into authorization to
          // build, deploy, merge or mark the PR ready. Stop and persist.
          return Promise.resolve({
            verdict: 'BLOCKED' as const,
            sha: state.headSha!,
            evidenceId: `pilot-ci-${state.headSha!.slice(0, 16)}`,
            defectCode: 'PILOT_END_BEFORE_CI',
          });
        }
        const checked = verifyExactCi(api, state.headSha ?? '', state.prNumber);
        return Promise.resolve({
          verdict: 'PASS',
          sha: state.headSha!,
          evidenceId: `quality-${createHash('sha256').update(checked.url).digest('hex').slice(0, 16)}`,
        });
      }
      if ((gate === 'LAB_DEPLOY' || gate === 'LAB_E2E') && !config.labActivated)
        throw new Error('Lab activation has not been approved');
      mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
      if (['IMPLEMENTATION', 'REVIEW', 'QA'].includes(gate)) {
        const day = new Date().toISOString().slice(0, 10);
        const usagePath = join(config.evidenceDir, 'usage.json');
        let usage: Record<string, number> = {};
        try {
          usage = JSON.parse(readFileSync(usagePath, 'utf8')) as Record<
            string,
            number
          >;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if ((usage[day] ?? 0) >= config.maxModelCallsPerDay)
          throw new Error('Daily model call budget exhausted');
        usage[day] = (usage[day] ?? 0) + 1;
        const temp = `${usagePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(usage), { mode: 0o600 });
        renameSync(temp, usagePath);
      }
      const command = config.commands[gate];
      if (!command) throw new Error(`Gate ${gate} has no configured command`);
      const input = JSON.stringify({
        idempotencyKey: key,
        taskId: state.taskId,
        attempt: state.attempt,
        specPath: state.specPath,
        specSha: state.specSha,
        baseSha: state.baseSha,
        headSha: state.headSha,
        candidateSha: state.candidateSha,
        deploymentDigest: state.deploymentDigest,
        gate,
        worktree:
          gate === 'IMPLEMENTATION' || gate === 'REVIEW' || gate === 'QA'
            ? config.worktrees[gate]
            : undefined,
        sourceRepo: config.sourceRepo,
        candidateWorktree: config.candidateWorktree,
        pnpmExecutable: config.pnpmExecutable,
        codexExecutable: config.codexExecutable,
      });
      const output = execFileSync(command.executable, command.args, {
        input,
        encoding: 'utf8',
        timeout: command.timeoutMs,
        maxBuffer: 256_000,
        env: {
          HOME: homedir(),
          PATH: '/usr/bin:/bin:/home/hossein/.local/bin',
          USER: process.env.USER ?? '',
          FAIR_MODEL_CONFIG: config.modelFile,
        },
      });
      const evidence = JSON.parse(output) as Evidence;
      if (
        !['PASS', 'FAIL', 'BLOCKED'].includes(evidence.verdict) ||
        !/^[a-zA-Z0-9_.:-]{1,120}$/.test(evidence.evidenceId)
      )
        throw new Error('Invalid gate evidence');
      const path = join(
        config.evidenceDir,
        `${createHash('sha256').update(key).digest('hex')}.json`,
      );
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(
        temp,
        JSON.stringify(receiptFor(state, gate, key, evidence)),
        { mode: 0o600 },
      );
      renameSync(temp, path);
      return Promise.resolve(evidence);
    },
    recover(_gate, _state, key) {
      if (_gate === 'CI') {
        if (config.pilotMode)
          return Promise.resolve({
            verdict: 'BLOCKED' as const,
            sha: _state.headSha!,
            evidenceId: `pilot-ci-${_state.headSha!.slice(0, 16)}`,
            defectCode: 'PILOT_END_BEFORE_CI',
          });
        const checked = verifyExactCi(
          api,
          _state.headSha ?? '',
          _state.prNumber,
        );
        return Promise.resolve({
          verdict: 'PASS' as const,
          sha: _state.headSha!,
          evidenceId: `quality-${createHash('sha256').update(checked.url).digest('hex').slice(0, 16)}`,
        });
      }
      const path = join(
        config.evidenceDir,
        `${createHash('sha256').update(key).digest('hex')}.json`,
      );
      try {
        const receipt = JSON.parse(readFileSync(path, 'utf8')) as Receipt;
        return Promise.resolve(
          verifyReceipt(config, _state, _gate, key, receipt),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return Promise.resolve(undefined);
        throw error;
      }
    },
    report(state, gate, evidence) {
      postVerdict(api, state, gate, evidence.verdict, evidence.evidenceId);
      if (state.prNumber)
        postVerdict(
          api,
          state,
          gate,
          evidence.verdict,
          evidence.evidenceId,
          state.prNumber,
        );
      return Promise.resolve();
    },
  };
}

export async function runOnce(configPath: string): Promise<void> {
  if (
    isProtectedPath(configPath, join(homedir(), '.config/fair-platform/tasks'))
  )
    verifyInternalLock();
  const config = loadConfig(configPath);
  if (usesSupervisedResources(configPath, config)) verifyInternalLock();
  const store = new StateStore(config.stateFile);
  const api = new GhTransport(
    readFileSync(config.githubTokenFile, 'utf8').trim(),
    config.ghExecutable,
  );
  const approved = approvedIssue(
    api,
    config.issue,
    config.ownerLogin,
    config.pilotMode === true,
  );
  const state = store.load() ?? approved;
  if (
    state.taskId !== approved.taskId ||
    state.specSha !== approved.specSha ||
    state.baseSha !== approved.baseSha ||
    state.specPath !== approved.specPath
  )
    throw new Error('Active task differs from approved issue');
  // The lock covers one transition. Scheduler invokes this process repeatedly, serially.
  await store.withLock(() =>
    new Orchestrator(commandPorts(config), (value) => store.save(value)).step(
      state,
    ),
  );
}

function isProtectedPath(path: string, root: string): boolean {
  const canonical = (value: string): string => {
    const absolute = resolve(value);
    try {
      return realpathSync(absolute);
    } catch {
      try {
        return join(realpathSync(dirname(absolute)), basename(absolute));
      } catch {
        return absolute;
      }
    }
  };
  const subpath = relative(canonical(root), canonical(path));
  return (
    subpath === '' ||
    (subpath !== '..' && !subpath.startsWith('../') && !isAbsolute(subpath))
  );
}

/** A copied config cannot shed the lock while retaining protected task paths. */
export function usesSupervisedResources(
  configPath: string,
  config: Pick<
    Config,
    'stateFile' | 'evidenceDir' | 'worktrees' | 'candidateWorktree'
  >,
): boolean {
  const home = homedir();
  const roots = [
    join(home, '.config/fair-platform/tasks'),
    join(home, '.local/state/fair-platform/tasks'),
    join(home, 'Work/fair-agent-tasks'),
  ];
  return [
    configPath,
    config.stateFile,
    config.evidenceDir,
    config.candidateWorktree,
    ...Object.values(config.worktrees),
  ].some((path) => roots.some((root) => isProtectedPath(path, root)));
}

if (process.argv[1]?.endsWith('/runner.js')) {
  const path =
    process.argv[2] ??
    join(homedir(), '.config/fair-platform/orchestrator.json');
  runOnce(path).catch((error) => {
    process.stderr.write(`Orchestrator stopped: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

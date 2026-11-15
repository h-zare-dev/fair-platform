import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const tokenPath = join(home, '.local/share/fair-platform/github-token');
const modelPath = join(home, '.local/bin/fair-agent-models.conf');

export function parseCommand(args: string[]): {
  command: string;
  issue: number;
} {
  if (
    args.length !== 2 ||
    !['preflight', 'prepare', 'run', 'tmux'].includes(args[0]!) ||
    !/^[1-9][0-9]*$/.test(args[1]!)
  )
    throw new Error(
      'Usage: supervised <preflight|prepare|run|tmux> <positive-issue-number>',
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
  if (state?.inFlight)
    throw new Error('Unresolved in-flight gate requires manual recovery');
  if (state?.pendingReport)
    throw new Error('Pending gate report requires manual recovery');
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
    if (
      top !== path ||
      execFileSync(git, ['-C', path, 'status', '--porcelain'], {
        encoding: 'utf8',
      }).trim()
    )
      throw new Error(`Unsafe or dirty ${role} worktree`);
    const head = execFileSync(git, ['-C', path, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (
      head !==
      (role === 'IMPLEMENTATION'
        ? (state.headSha ?? state.baseSha)
        : state.headSha)
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
function locked(command: string, issue: number): void {
  safeDir(dirname(lockPath));
  if (existsSync(lockPath)) privatePath(lockPath);
  const result = spawnSync(
    '/usr/bin/flock',
    [
      '-n',
      lockPath,
      process.execPath,
      resolve('scripts/orchestrator/dist/supervised.js'),
      `internal-${command}`,
      String(issue),
    ],
    { stdio: 'inherit' },
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
  const { command, issue } = parseCommand(
    internal ? [args[0]!.slice(9), args[1]!] : args,
  );
  if (!internal && (command === 'prepare' || command === 'run')) {
    locked(command, issue);
    return;
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
  if (command === 'run') {
    checkExisting(issue, approved);
    const p = paths(issue);
    if (!existsSync(p.config)) throw new Error('Run prepare first');
    prepare(issue, approved);
    await runPilot(p.config);
    return;
  }
  checkExisting(issue, approved);
  prepareCheckForTmux(issue);
  const script = resolve('scripts/orchestrator/supervised-tmux.sh');
  const result = spawnSync(
    '/bin/bash',
    [
      script,
      String(issue),
      resolve('scripts/orchestrator/dist/supervised.js'),
      paths(issue).state,
      paths(issue).evidence,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('tmux launch refused');
}
function prepareCheckForTmux(issue: number): void {
  const config = paths(issue).config;
  if (!existsSync(config)) throw new Error('Run prepare first');
  privatePath(config);
}
if (process.argv[1]?.endsWith('/supervised.js'))
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });

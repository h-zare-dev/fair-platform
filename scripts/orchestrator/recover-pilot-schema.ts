import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './runner.js';
import { StateStore, type TaskState } from './state.js';

/**
 * One-time recovery after the confirmed Codex 400 invalid JSON schema error.
 * Never use this routine to recover a command that might have committed,
 * published, produced durable evidence, or modified its worktree.
 */
export function isSchemaPilotRetrySafe(state: TaskState): boolean {
  const expectedKey = `${state.taskId}:${state.attempt}:IMPLEMENTATION:${state.baseSha}:-`;
  const latest = state.transitions.at(-1);
  const allowedPhase =
    (state.phase === 'IMPLEMENTING' && latest?.phase === 'IMPLEMENTING') ||
    (state.phase === 'BLOCKED' &&
      latest?.errorCode === 'UNRESOLVED_INFLIGHT');
  return (
    state.taskId === 57 &&
    allowedPhase &&
    state.attempt === 1 &&
    state.reworks === 0 &&
    state.inFlight?.gate === 'IMPLEMENTATION' &&
    state.inFlight.key === expectedKey &&
    state.headSha === undefined &&
    state.candidateSha === undefined &&
    state.prNumber === undefined &&
    state.pendingReport === undefined &&
    Object.keys(state.verdicts).length === 0
  );
}

export async function recoverPilotSchema(configPath: string): Promise<string> {
  const config = loadConfig(configPath);
  if (
    config.issue !== 57 ||
    config.pilotMode !== true ||
    config.labActivated !== false
  )
    throw new Error('Schema recovery is restricted to pilot task #57');
  const store = new StateStore(config.stateFile);
  return store.withLock(() => {
    const state = store.load();
    if (!state || !isSchemaPilotRetrySafe(state))
      throw new Error('No safely recoverable schema failure checkpoint');
    const worktree = config.worktrees.IMPLEMENTATION;
    const git = (args: string[]): string =>
      execFileSync('/usr/bin/git', ['-C', worktree, ...args], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin' },
      }).trim();
    const expectedBranch = `agent/57-${state.specSha.slice(0, 12)}`;
    if (
      git(['rev-parse', 'HEAD']) !== state.baseSha ||
      git(['branch', '--show-current']) !== expectedBranch ||
      git(['status', '--porcelain']) !== ''
    )
      throw new Error(
        'Implementation worktree is not pristine at approved base',
      );
    const key = state.inFlight!.key;
    const receiptFile = join(
      config.evidenceDir,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
    if (existsSync(receiptFile))
      throw new Error('Existing execution evidence requires manual review');
    const remote = execFileSync(
      '/usr/bin/git',
      ['-C', config.sourceRepo, 'ls-remote', '--heads', 'origin', expectedBranch],
      { encoding: 'utf8', timeout: 20_000 },
    ).trim();
    if (remote !== '')
      throw new Error('Remote implementation branch exists; refusing retry');
    const backup = `${config.stateFile}.schema-recovery-backup`;
    copyFileSync(config.stateFile, backup, constants.COPYFILE_EXCL);
    delete state.inFlight;
    state.phase = 'IMPLEMENTING';
    state.transitions.push({
      at: new Date().toISOString(),
      attempt: state.attempt,
      phase: 'IMPLEMENTING',
      actor: 'operator-verified-schema-retry',
      errorCode: 'CODEX_SCHEMA_400_RECOVERED',
    });
    store.save(state);
    return Promise.resolve(
      `RECOVERED_SCHEMA_ONLY | issue=57 | attempt=1 | backup=${backup}`,
    );
  });
}

if (process.argv[1]?.endsWith('/recover-pilot-schema.js')) {
  const path =
    process.argv[2] ?? join(homedir(), '.config/fair-platform/pilot.json');
  recoverPilotSchema(path)
    .then((line) => process.stdout.write(`${line}\n`))
    .catch((error) => {
      process.stderr.write(
        `Schema recovery blocked: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
}

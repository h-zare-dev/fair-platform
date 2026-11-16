import { homedir } from 'node:os';
import { join } from 'node:path';
import { runOnce, loadConfig } from './runner.js';
import { StateStore, type TaskState } from './state.js';

export const PILOT_TERMINAL_PHASES = [
  'BLOCKED',
  'DONE',
  'READY_FOR_OWNER_REVIEW',
] as const;

export function pilotSummary(state: Readonly<TaskState>): string {
  const latest = state.transitions.at(-1);
  const latestGate = latest?.actor ?? '-';
  const lastError = latest?.errorCode ?? '-';
  return [
    `ISSUE=${state.taskId}`,
    `PHASE=${state.phase}`,
    `ATTEMPT=${state.attempt}`,
    `HEAD=${state.headSha ?? '-'}`,
    `GATE=${latestGate}`,
    `ERROR=${lastError}`,
  ].join(' | ');
}

/**
 * The pilot orchestrates actual model gates, one durable transition at a
 * time. It cannot build candidates, deploy to Lab or merge a pull request.
 * No issue is manufactured here: the ordinary authenticated Owner approval
 * requirements in runOnce() remain mandatory.
 */
export function isRetryablePublishError(
  error: unknown,
  state: Readonly<TaskState> | undefined,
): boolean {
  return (
    state?.phase === 'IMPLEMENTING' &&
    state.inFlight?.gate === 'IMPLEMENTATION' &&
    error instanceof Error &&
    ['PR is not exact draft head', 'PR head/base/draft state drifted'].includes(
      error.message,
    )
  );
}

export function isBudgetPauseError(
  error: unknown,
  state: Readonly<TaskState> | undefined,
): boolean {
  return (
    error instanceof Error &&
    error.message === 'Daily model call budget exhausted' &&
    !!state &&
    !state.inFlight &&
    !state.pendingReport &&
    (state.phase === 'IMPLEMENTING' ||
      state.phase === 'REVIEWING' ||
      state.phase === 'QA')
  );
}

/** UTC rollover matches the usage.json day key, never local wall time. */
export function nextBudgetResetUtc(now = new Date()): Date {
  const reset = new Date(now.getTime());
  reset.setUTCHours(24, 0, 0, 0);
  return reset;
}

export async function runPilot(
  configPath: string,
  onProgress: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Promise<TaskState> {
  const config = loadConfig(configPath);
  if (config.pilotMode !== true || config.labActivated !== false)
    throw new Error('Explicit non-Lab pilot configuration is required');
  const store = new StateStore(config.stateFile);
  // Bounded even if a malformed state machine cycles unexpectedly. The
  // separate model-call budget and max-rework count are enforced by the runner.
  let transientRetries = 0;
  for (let tick = 0; tick < 40;) {
    try {
      await runOnce(configPath);
      transientRetries = 0;
      tick++;
    } catch (error) {
      // Re-enter only the saved in-flight Implementation with its immutable
      // receipt. runOnce/runner revalidate GitHub identity before recovery.
      // Neither an unverified model execution nor a different PR may retry.
      const state = store.load();
      if (isBudgetPauseError(error, state)) {
        const reset = nextBudgetResetUtc();
        onProgress(`MODEL_BUDGET_WAIT | resume_utc=${reset.toISOString()}`);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(1, reset.getTime() - Date.now() + 1000)),
        );
        // State contains no in-flight operation. Re-check Owner approval,
        // development SHA and capacity on the next iteration.
        continue;
      }
      if (!isRetryablePublishError(error, state) || transientRetries >= 8)
        throw error;
      transientRetries++;
      onProgress(`PUBLISH_RECONCILE_RETRY ${transientRetries}/8`);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(transientRetries * 1000, 5000)),
      );
      continue;
    }
    const state = store.load();
    if (!state) throw new Error('Pilot did not persist an active task');
    onProgress(pilotSummary(state));
    if (new Set<string>(PILOT_TERMINAL_PHASES).has(state.phase)) return state;
  }
  throw new Error('Pilot reached bounded transition limit');
}

if (process.argv[1]?.endsWith('/pilot.js')) {
  const path =
    process.argv[2] ?? join(homedir(), '.config/fair-platform/pilot.json');
  runPilot(path).catch((error) => {
    process.stderr.write(`Pilot stopped: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

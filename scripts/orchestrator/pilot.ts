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
  for (let tick = 0; tick < 40; tick++) {
    await runOnce(configPath);
    const state = store.load();
    if (!state) throw new Error('Pilot did not persist an active task');
    onProgress(pilotSummary(state));
    if (new Set<string>(PILOT_TERMINAL_PHASES).has(state.phase))
      return state;
  }
  throw new Error('Pilot reached bounded transition limit');
}

if (process.argv[1]?.endsWith('/pilot.js')) {
  const path =
    process.argv[2] ??
    join(homedir(), '.config/fair-platform/pilot.json');
  runPilot(path).catch((error) => {
    process.stderr.write(`Pilot stopped: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

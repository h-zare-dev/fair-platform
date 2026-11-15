import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadModelRoutes, type ModelRoute, type Role } from './models.js';
import { StateStore, type Gate, type TaskState } from './state.js';

const roles = [
  'IMPLEMENTATION',
  'REVIEW',
  'QA',
  'LAB',
  'REPLAY',
  'FALLBACK',
  'REPORT',
] as const satisfies readonly Role[];

const gateByRole: Partial<Record<Role, Gate>> = {
  IMPLEMENTATION: 'IMPLEMENTATION',
  REVIEW: 'REVIEW',
  QA: 'QA',
  LAB: 'LAB_DEPLOY',
};

export type RoleStatus = {
  role: Role;
  model: string;
  effort: ModelRoute['effort'];
  activity:
    | 'IDLE'
    | 'LAST_PASS'
    | 'LAST_FAIL'
    | 'LAST_BLOCKED'
    | 'IN_FLIGHT_UNVERIFIED';
  testedSha?: string;
};

export type OrchestratorStatus = {
  activeTask: number | null;
  phase: string;
  attempt: number | null;
  reworks: number | null;
  headSha: string | null;
  candidateSha: string | null;
  lastErrorCode: string | null;
  lastTransitionAt: string | null;
  roles: RoleStatus[];
  note: string;
};

/**
 * Display persisted, SHA-bound facts without assuming a saved in-flight
 * checkpoint proves that a Codex or SSH process is still alive.
 *
 * This is a read-only inspection tool: no GitHub credential, model call,
 * network connection, SSH command or orchestration step is performed.
 */
export function createStatusSnapshot(
  task: TaskState | undefined,
  models: Record<Role, ModelRoute>,
): OrchestratorStatus {
  const last = task?.transitions.at(-1);
  const error = last?.errorCode;
  const errorCode =
    typeof error === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(error)
      ? error
      : null;

  return {
    activeTask: task?.taskId ?? null,
    phase: task?.phase ?? 'NOT_STARTED',
    attempt: task?.attempt ?? null,
    reworks: task?.reworks ?? null,
    headSha: task?.headSha ?? null,
    candidateSha: task?.candidateSha ?? null,
    lastErrorCode: errorCode,
    lastTransitionAt: last?.at ?? null,
    roles: roles.map((role) => {
      const route = models[role];
      const gate = gateByRole[role];
      const verdict = gate ? task?.verdicts[gate] : undefined;
      let activity: RoleStatus['activity'] = 'IDLE';
      if (gate && task?.inFlight?.gate === gate) {
        activity = 'IN_FLIGHT_UNVERIFIED';
      } else if (verdict) {
        activity =
          verdict.verdict === 'PASS'
            ? 'LAST_PASS'
            : verdict.verdict === 'FAIL'
              ? 'LAST_FAIL'
              : 'LAST_BLOCKED';
      }
      return {
        role,
        model: route.model,
        effort: route.effort,
        activity,
        ...(verdict?.sha ? { testedSha: verdict.sha } : {}),
      };
    }),
    note:
      'State-file snapshot only. IN_FLIGHT_UNVERIFIED is not a process-health ' +
      'signal. This command does not activate the runner or Lab.',
  };
}

export function renderStatus(snapshot: OrchestratorStatus): string {
  const short = (sha: string | null | undefined): string =>
    sha ? sha.slice(0, 12) : '-';
  const summary = [
    'Fair Platform | agent status (read-only)',
    `Task: ${snapshot.activeTask ?? 'none'} | phase: ${snapshot.phase} | attempt: ${snapshot.attempt ?? '-'} | reworks: ${snapshot.reworks ?? '-'}`,
    `Head: ${short(snapshot.headSha)} | candidate: ${short(snapshot.candidateSha)}`,
    `Last transition: ${snapshot.lastTransitionAt ?? '-'} | error: ${snapshot.lastErrorCode ?? '-'}`,
    '',
    'ROLE            MODEL           EFFORT  ACTIVITY                 VERIFIED SHA',
  ];
  for (const role of snapshot.roles) {
    summary.push(
      `${role.role.padEnd(15)} ${role.model.padEnd(15)} ${role.effort.padEnd(7)} ${role.activity.padEnd(24)} ${short(role.testedSha)}`,
    );
  }
  summary.push('', snapshot.note);
  return summary.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter((arg) => arg !== '--json');
  if (paths.length > 2 || paths.some((arg) => arg.startsWith('-'))) {
    throw new Error('Usage: status.js [state-file] [model-config] [--json]');
  }
  const stateFile =
    paths[0] ?? join(homedir(), '.local/state/fair-platform/task.json');
  const modelFile =
    paths[1] ?? join(homedir(), '.local/bin/fair-agent-models.conf');

  const task = new StateStore(stateFile).load();
  const snapshot = createStatusSnapshot(task, loadModelRoutes(modelFile));
  process.stdout.write(
    json
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : `${renderStatus(snapshot)}\n`,
  );
}

if (process.argv[1]?.endsWith('/status.js')) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Agent status unavailable: ${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  }
}

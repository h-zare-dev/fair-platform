import { describe, expect, it } from 'vitest';
import { createStatusSnapshot, renderStatus } from '../../scripts/orchestrator/status.js';
import { newTask } from '../../scripts/orchestrator/state.js';
import type { ModelRoute, Role } from '../../scripts/orchestrator/models.js';

const models: Record<Role, ModelRoute> = {
  IMPLEMENTATION: { model: 'gpt-6-sol', effort: 'low' },
  REVIEW: { model: 'gpt-6-sol', effort: 'low' },
  QA: { model: 'gpt-6-luna', effort: 'low' },
  LAB: { model: 'gpt-6-luna', effort: 'low' },
  REPLAY: { model: 'gpt-6-luna', effort: 'low' },
  FALLBACK: { model: 'gpt-6-luna', effort: 'low' },
  REPORT: { model: 'gpt-6-luna', effort: 'none' },
};

const sha = (digit: string): string => digit.repeat(40);

describe('read-only agent status snapshot', () => {
  it('shows configured Sol/Luna roles without fabricating active agents', () => {
    const snapshot = createStatusSnapshot(undefined, models);
    expect(snapshot.phase).toBe('NOT_STARTED');
    expect(snapshot.activeTask).toBeNull();
    expect(snapshot.roles).toHaveLength(7);
    expect(snapshot.roles.every((role) => role.activity === 'IDLE')).toBe(
      true,
    );
    expect(snapshot.roles.find((role) => role.role === 'QA')).toMatchObject({
      model: 'gpt-6-luna',
      effort: 'low',
    });
    expect(renderStatus(snapshot)).toContain('State-file snapshot only');
  });

  it('identifies in-flight checkpoints without claiming process liveness', () => {
    const task = newTask(57, 'docs/tasks/ISSUE-57.md', sha('a'), sha('b'));
    task.phase = 'REVIEWING';
    task.headSha = sha('c');
    task.inFlight = {
      gate: 'REVIEW',
      key: 'review-1',
      startedAt: '2026-11-14T18:00:00.000Z',
    };
    task.verdicts.IMPLEMENTATION = {
      verdict: 'PASS',
      sha: sha('c'),
      evidenceId: 'impl-1',
    };
    const snapshot = createStatusSnapshot(task, models);
    expect(snapshot.roles.find((role) => role.role === 'REVIEW')?.activity).toBe(
      'IN_FLIGHT_UNVERIFIED',
    );
    expect(
      snapshot.roles.find((role) => role.role === 'IMPLEMENTATION'),
    ).toMatchObject({ activity: 'LAST_PASS', testedSha: sha('c') });
    expect(renderStatus(snapshot)).toContain(sha('c').slice(0, 12));
  });

  it('sanitizes error codes and never exposes arbitrary transition text', () => {
    const task = newTask(58, 'docs/tasks/ISSUE-58.md', sha('a'), sha('b'));
    task.phase = 'BLOCKED';
    task.transitions.push({
      at: '2026-11-14T18:00:00.000Z',
      attempt: 1,
      phase: 'BLOCKED',
      actor: 'QA',
      errorCode: 'some private information in an error',
    });
    const snapshot = createStatusSnapshot(task, models);
    expect(snapshot.lastErrorCode).toBeNull();
    expect(renderStatus(snapshot)).not.toContain('private information');
  });
});

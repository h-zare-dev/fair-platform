import { describe, expect, it } from 'vitest';
import { createStatusSnapshot } from '../../scripts/orchestrator/status.js';
import { renderStatus } from '../../scripts/orchestrator/status.js';
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

describe('agent status snapshot', () => {
  it('does not invent active agents for a missing task', () => {
    const status = createStatusSnapshot(undefined, models);
    expect(status.phase).toBe('NOT_STARTED');
    expect(status.activeTask).toBeNull();
    expect(status.roles).toHaveLength(7);
    expect(status.roles[2]?.model).toBe('gpt-6-luna');
    expect(status.roles[2]?.activity).toBe('IDLE');
    expect(renderStatus(status)).toContain('State-file snapshot only');
  });

  it('does not report a saved in-flight gate as a live process', () => {
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
    const status = createStatusSnapshot(task, models);
    expect(status.roles[0]?.activity).toBe('LAST_PASS');
    expect(status.roles[0]?.testedSha).toBe(sha('c'));
    expect(status.roles[1]?.activity).toBe('IN_FLIGHT_UNVERIFIED');
    expect(renderStatus(status)).toContain(sha('c').slice(0, 12));
  });

  it('does not print untrusted error messages', () => {
    const task = newTask(58, 'docs/tasks/ISSUE-58.md', sha('a'), sha('b'));
    task.phase = 'BLOCKED';
    task.transitions.push({
      at: '2026-11-14T18:00:00.000Z',
      attempt: 1,
      phase: 'BLOCKED',
      actor: 'QA',
      errorCode: 'secret value in free-form text',
    });
    const status = createStatusSnapshot(task, models);
    expect(status.lastErrorCode).toBeNull();
    expect(renderStatus(status)).not.toContain('secret value');
  });
});

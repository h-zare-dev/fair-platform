import { describe, expect, it } from 'vitest';
import {
  eligibleIssues,
  safeTaskDisposition,
} from '../../scripts/orchestrator/queue.js';
import { newTask } from '../../scripts/orchestrator/state.js';

describe('queue admission', () => {
  it('sorts and excludes PRs and blocked issues', () => {
    const api = {
      get: () => [
        { number: 9, labels: [{ name: 'agent:approved' }] },
        { number: 3, labels: [{ name: 'agent:approved' }] },
        { number: 4, pull_request: {}, labels: [{ name: 'agent:approved' }] },
        { number: 5, labels: [{ name: 'agent:blocked' }] },
        { number: 6, labels: [] },
      ],
      post: () => ({}),
    };
    expect(eligibleIssues(api)).toEqual([3, 9]);
  });
  it('quarantines all unresolved in-flight and publication checkpoints', () => {
    const task = newTask(
      68,
      'docs/tasks/OPS-068-durable-agent-queue-resume.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    expect(safeTaskDisposition(task)).toBe('resume');
    task.inFlight = { gate: 'IMPLEMENTATION', key: 'key', startedAt: 'now' };
    expect(safeTaskDisposition(task)).toBe('blocked');
    task.inFlight = undefined;
    task.phase = 'READY_FOR_OWNER_REVIEW';
    expect(safeTaskDisposition(task)).toBe('done');
  });
  it('recognizes only an exact Owner-held Draft PR boundary as completed', () => {
    const task = newTask(
      68,
      'docs/tasks/OPS-068-durable-agent-queue-resume.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    task.phase = 'BLOCKED';
    task.headSha = 'c'.repeat(40);
    task.prNumber = 70;
    for (const gate of ['IMPLEMENTATION', 'REVIEW', 'QA'] as const)
      task.verdicts[gate] = {
        verdict: 'PASS',
        sha: task.headSha,
        evidenceId: gate,
      };
    task.transitions.push({
      at: new Date().toISOString(),
      attempt: 1,
      phase: 'BLOCKED',
      actor: 'CI',
      errorCode: 'PILOT_END_BEFORE_CI',
    });
    expect(safeTaskDisposition(task)).toBe('done');
    task.prNumber = undefined;
    expect(safeTaskDisposition(task)).toBe('blocked');
    task.prNumber = 70;
    task.inFlight = { gate: 'QA', key: 'unresolved', startedAt: 'now' };
    expect(safeTaskDisposition(task)).toBe('blocked');
  });
});

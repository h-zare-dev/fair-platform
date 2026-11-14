import { describe, expect, it } from 'vitest';
import { isSchemaPilotRetrySafe } from '../../scripts/orchestrator/recover-pilot-schema.js';
import { newTask } from '../../scripts/orchestrator/state.js';

const sha = (value: string): string => value.repeat(40);

describe('schema-400 pilot recovery eligibility', () => {
  const firstAttempt = () => {
    const state = newTask(
      57,
      'docs/tasks/PILOT-001-automatic-agent-chain.md',
      sha('a'),
      sha('b'),
    );
    state.phase = 'IMPLEMENTING';
    state.inFlight = {
      gate: 'IMPLEMENTATION',
      key: `57:1:IMPLEMENTATION:${sha('b')}:-`,
      startedAt: '2026-11-14T21:36:00.000Z',
    };
    state.transitions.push({
      at: '2026-11-14T21:36:00.000Z',
      phase: 'IMPLEMENTING',
      actor: 'orchestrator',
      attempt: 1,
    });
    return state;
  };

  it('allows only the exact original in-flight task checkpoint', () => {
    expect(isSchemaPilotRetrySafe(firstAttempt())).toBe(true);
  });

  it('rejects retries if a gate completed or changed attempts', () => {
    const state = firstAttempt();
    state.attempt = 2;
    expect(isSchemaPilotRetrySafe(state)).toBe(false);
    state.attempt = 1;
    state.headSha = sha('c');
    expect(isSchemaPilotRetrySafe(state)).toBe(false);
  });

  it('rejects altered in-flight keys and unrelated tasks', () => {
    const state = firstAttempt();
    state.inFlight!.key = 'different-key';
    expect(isSchemaPilotRetrySafe(state)).toBe(false);
    state.inFlight!.key = `57:1:IMPLEMENTATION:${sha('b')}:-`;
    state.taskId = 99;
    expect(isSchemaPilotRetrySafe(state)).toBe(false);
  });

  it('allows only a known interrupted implementation checkpoint', () => {
    const state = firstAttempt();
    state.phase = 'BLOCKED';
    state.transitions.push({
      at: '2026-11-14T21:38:00.000Z',
      phase: 'BLOCKED',
      actor: 'orchestrator',
      attempt: 1,
      errorCode: 'UNRESOLVED_INFLIGHT',
    });
    expect(isSchemaPilotRetrySafe(state)).toBe(true);
    state.transitions[state.transitions.length - 1]!.errorCode = 'OTHER';
    expect(isSchemaPilotRetrySafe(state)).toBe(false);
  });
});

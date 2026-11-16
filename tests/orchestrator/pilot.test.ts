import { describe, expect, it } from 'vitest';
import {
  pilotSummary,
  PILOT_TERMINAL_PHASES,
  isRetryablePublishError,
} from '../../scripts/orchestrator/pilot.js';
import { newTask } from '../../scripts/orchestrator/state.js';

const sha = (digit: string): string => digit.repeat(40);

describe('supervised pilot control', () => {
  it('does not treat running gates as terminal states', () => {
    expect(PILOT_TERMINAL_PHASES).toContain('BLOCKED');
    expect(PILOT_TERMINAL_PHASES).not.toContain('IMPLEMENTING');
    expect(PILOT_TERMINAL_PHASES).not.toContain('REVIEWING');
    expect(PILOT_TERMINAL_PHASES).not.toContain('QA');
  });

  it('shows durable task phase, exact head, attempt and sanitized error', () => {
    const state = newTask(73, 'docs/tasks/PILOT-001.md', sha('a'), sha('b'));
    state.phase = 'BLOCKED';
    state.headSha = sha('c');
    state.transitions.push({
      at: '2026-11-14T20:00:00Z',
      attempt: 1,
      phase: 'BLOCKED',
      actor: 'CI',
      headSha: sha('c'),
      errorCode: 'PILOT_END_BEFORE_CI',
    });
    expect(pilotSummary(state)).toContain('ISSUE=73');
    expect(pilotSummary(state)).toContain('PHASE=BLOCKED');
    expect(pilotSummary(state)).toContain(`HEAD=${sha('c')}`);
    expect(pilotSummary(state)).toContain('ERROR=PILOT_END_BEFORE_CI');
  });

  it('retries a transient PR publication failure only for a saved Implementation flight', () => {
    const state = newTask(59, 'docs/tasks/TASK-59.md', sha('a'), sha('b'));
    state.phase = 'IMPLEMENTING';
    state.inFlight = {
      gate: 'IMPLEMENTATION',
      key: '59:1:IMPLEMENTATION',
      startedAt: '2026-11-16T10:00:00Z',
    };
    expect(
      isRetryablePublishError(new Error('PR is not exact draft head'), state),
    ).toBe(true);
    expect(
      isRetryablePublishError(
        new Error('PR head/base/draft state drifted'),
        state,
      ),
    ).toBe(true);
    expect(
      isRetryablePublishError(
        new Error('Missing authenticated Owner approval of exact spec'),
        state,
      ),
    ).toBe(false);
    state.phase = 'REVIEWING';
    expect(
      isRetryablePublishError(new Error('PR is not exact draft head'), state),
    ).toBe(false);
    state.phase = 'IMPLEMENTING';
    state.inFlight = undefined;
    expect(
      isRetryablePublishError(new Error('PR is not exact draft head'), state),
    ).toBe(false);
  });
});

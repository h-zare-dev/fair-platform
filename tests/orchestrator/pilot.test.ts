import { describe, expect, it } from 'vitest';
import {
  pilotSummary,
  PILOT_TERMINAL_PHASES,
  isBudgetPauseError,
  nextBudgetResetUtc,
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

  it('waits only on a quota rejection that did not start an in-flight command', () => {
    const state = newTask(62, 'docs/tasks/TASK-62.md', sha('a'), sha('b'));
    state.phase = 'IMPLEMENTING';
    const error = new Error('Daily model call budget exhausted');
    expect(isBudgetPauseError(error, state)).toBe(true);
    state.inFlight = {
      gate: 'IMPLEMENTATION',
      key: '62:4:IMPLEMENTATION',
      startedAt: '2026-11-16T16:00:00Z',
    };
    expect(isBudgetPauseError(error, state)).toBe(false);
    state.inFlight = undefined;
    state.phase = 'BLOCKED';
    expect(isBudgetPauseError(error, state)).toBe(false);
    expect(isBudgetPauseError(new Error('Permission denied'), state)).toBe(
      false,
    );
  });

  it('calculates the next UTC reset used by the daily quota', () => {
    expect(
      nextBudgetResetUtc(new Date('2026-11-16T17:20:00Z')).toISOString(),
    ).toBe('2026-11-17T00:00:00.000Z');
  });

});

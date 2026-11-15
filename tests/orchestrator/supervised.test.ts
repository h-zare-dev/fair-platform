import { describe, expect, it } from 'vitest';
import { parseCommand, paths } from '../../scripts/orchestrator/supervised.js';

describe('supervised issue identity', () => {
  it('accepts one explicit positive issue', () => {
    expect(parseCommand(['preflight', '59'])).toEqual({
      command: 'preflight',
      issue: 59,
    });
    expect(parseCommand(['run', '123']).issue).toBe(123);
  });
  it.each([
    [],
    ['run'],
    ['run', '0'],
    ['run', '-1'],
    ['run', '1', '2'],
    ['run', '01'],
    ['run', '1.0'],
    ['run', '57'],
    ['run', '9007199254740992'],
    ['poll', '59'],
    ['run', '1;id'],
  ])('rejects malformed or unauthorized input: %j', (...input) => {
    expect(() => parseCommand(input)).toThrow();
  });
  it('isolates every issue from the legacy pilot and other issues', () => {
    const a = paths(59);
    const b = paths(60);
    expect(a.config).not.toBe(b.config);
    expect(a.state).not.toBe(b.state);
    expect(a.evidence).not.toBe(b.evidence);
    expect(
      Object.values(a.worktrees).every((path) => path.includes('/59/')),
    ).toBe(true);
    expect(JSON.stringify(a)).not.toContain('pilot.json');
    expect(JSON.stringify(a)).not.toContain('/57/');
  });
});

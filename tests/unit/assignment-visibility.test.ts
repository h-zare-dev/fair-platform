import { describe, expect, it } from 'vitest';
import {
  assignmentExpired,
  partitionAssignments,
} from '../../apps/web/lib/assignment-visibility.js';

describe('Owner assignment visibility', () => {
  const tehranEnd = '2026-12-21T20:30:00.000Z'; // inclusive 1405-09-30
  const berlinDstEnd = '2026-10-25T23:00:00.000Z';

  it('keeps the full last Tehran calendar day and hides only after midnight', () => {
    expect(assignmentExpired(tehranEnd, Date.parse(tehranEnd) - 1)).toBe(false);
    expect(assignmentExpired(tehranEnd, Date.parse(tehranEnd))).toBe(true);
    expect(assignmentExpired(null, Date.parse(tehranEnd))).toBe(false);
  });

  it('uses stored instants even across a Berlin DST transition', () => {
    expect(
      assignmentExpired(berlinDstEnd, Date.parse('2026-10-25T22:59:59Z')),
    ).toBe(false);
    expect(
      assignmentExpired(berlinDstEnd, Date.parse('2026-10-25T23:00:00Z')),
    ).toBe(true);
  });

  it('separates expired assignments from active, future and unlimited records', () => {
    const rows = [
      { id: 'expired', effectiveUntil: tehranEnd },
      { id: 'future', effectiveUntil: '2027-12-21T20:30:00Z' },
      { id: 'unlimited', effectiveUntil: null },
      { id: 'malformed', effectiveUntil: 'INVALID' },
    ];
    const result = partitionAssignments(rows, Date.parse('2026-12-22T00:00Z'));
    expect(result.visible.map((a) => a.id)).toEqual([
      'future',
      'unlimited',
      'malformed',
    ]);
    expect(result.expired.map((a) => a.id)).toEqual(['expired']);
    expect(rows).toHaveLength(4); // historical records were not deleted
  });
});

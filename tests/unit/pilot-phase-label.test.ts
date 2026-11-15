import { describe, expect, it } from 'vitest';

import { formatPilotPhase } from '../../scripts/pilot/phase-label.js';

describe('formatPilotPhase', () => {
  it.each([
    ['QUEUED', 'Queued'],
    ['IMPLEMENTING', 'Implementing'],
    ['REVIEWING', 'Reviewing'],
    ['QA', 'Quality assurance'],
    ['BLOCKED', 'Blocked'],
  ])('formats %s as %s', (value, label) => {
    expect(formatPilotPhase(value)).toBe(label);
  });

  it.each(['UNKNOWN', 'DONE', 'queued', 'Qa', ''])(
    'returns Unknown for %j',
    (value) => {
      expect(formatPilotPhase(value)).toBe('Unknown');
    },
  );
});

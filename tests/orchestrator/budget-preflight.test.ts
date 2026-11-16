import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertModelCallCapacity } from '../../scripts/orchestrator/runner.js';

describe('daily model admission before in-flight checkpoint', () => {
  it('rejects the configured limit and allows the next UTC day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-budget-capacity-'));
    try {
      mkdirSync(join(dir, 'evidence'));
      const evidence = join(dir, 'evidence');
      writeFileSync(
        join(evidence, 'usage.json'),
        JSON.stringify({ '2026-11-16': 6 }),
      );
      expect(() => assertModelCallCapacity(evidence, 6, '2026-11-16')).toThrow(
        'Daily model call budget exhausted',
      );
      expect(() =>
        assertModelCallCapacity(evidence, 6, '2026-11-17'),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

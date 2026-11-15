import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('pilot #57 resume entrypoint', () => {
  it('resolves the real repository root from BASH_SOURCE', () => {
    const source = join(
      process.cwd(),
      'scripts/orchestrator/resume-pilot-57-once.sh',
    );
    const script = readFileSync(source, 'utf8');
    const rootLine = script
      .split('\n')
      .find((line) => line.startsWith('ROOT='));
    expect(rootLine).toBeDefined();
    expect(rootLine).toContain('${BASH_SOURCE[0]}');
    expect(rootLine).not.toContain('\\${BASH_SOURCE[0]}');

    const dir = mkdtempSync(join(tmpdir(), 'fair-pilot-root-'));
    try {
      const folder = join(dir, 'scripts', 'orchestrator');
      mkdirSync(folder, { recursive: true });
      const probe = join(folder, 'probe.sh');
      const probeContents = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        rootLine!,
        'printf "%s\\n" "$ROOT"',
      ].join('\n');
      writeFileSync(probe, probeContents);
      const syntax = spawnSync('/usr/bin/bash', ['-n', source], {
        encoding: 'utf8',
      });
      expect(syntax.status).toBe(0);
      const result = spawnSync('/usr/bin/bash', [probe], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

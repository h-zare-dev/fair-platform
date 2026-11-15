import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../scripts/orchestrator/runner.js';

describe('runner configuration', () => {
  it('rejects a string lab activation and an unsafe executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-config-'));
    try {
      const model = join(dir, 'models');
      writeFileSync(
        model,
        'IMPLEMENTATION_MODEL=gpt-6-sol\nIMPLEMENTATION_EFFORT=low\nREVIEW_MODEL=gpt-6-sol\nREVIEW_EFFORT=low\nQA_MODEL=gpt-6-luna\nQA_EFFORT=low\nLAB_MODEL=gpt-6-luna\nLAB_EFFORT=low\nREPLAY_MODEL=gpt-6-luna\nREPLAY_EFFORT=low\nFALLBACK_MODEL=gpt-6-luna\nFALLBACK_EFFORT=low\nREPORT_MODEL=gpt-6-luna\nREPORT_EFFORT=none\n',
        { mode: 0o600 },
      );
      const exe = join(dir, 'gate');
      writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const token = join(dir, 'token');
      writeFileSync(token, 'fixture', { mode: 0o600 });
      const commands = Object.fromEntries(
        [
          'IMPLEMENTATION',
          'REVIEW',
          'QA',
          'CANDIDATE',
          'LAB_DEPLOY',
          'LAB_E2E',
          'POST_MERGE',
        ].map((gate) => [gate, { executable: exe, args: [], timeoutMs: 1000 }]),
      );
      const config = {
        issue: 57,
        ownerLogin: 'h-zare-dev',
        stateFile: join(dir, 'state'),
        modelFile: model,
        evidenceDir: join(dir, 'evidence'),
        maxModelCallsPerDay: 3,
        labActivated: false,
        sourceRepo: dir,
        candidateWorktree: join(dir, 'fair-agent-candidate'),
        pnpmExecutable: exe,
        codexExecutable: exe,
        githubTokenFile: token,
        ghExecutable: exe,
        worktrees: {
          IMPLEMENTATION: join(dir, 'fair-agent-implementation'),
          REVIEW: join(dir, 'fair-agent-review'),
          QA: join(dir, 'fair-agent-qa'),
        },
        commands,
      };
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
      expect(loadConfig(path).labActivated).toBe(false);
      writeFileSync(path, JSON.stringify({ ...config, labActivated: 'false' }));
      expect(() => loadConfig(path)).toThrow('Invalid runner configuration');
      chmodSync(exe, 0o777);
      writeFileSync(path, JSON.stringify(config));
      expect(() => loadConfig(path)).toThrow(
        'Unsafe IMPLEMENTATION executable',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

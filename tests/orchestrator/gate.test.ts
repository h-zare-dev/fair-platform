import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCodexGate } from '../../scripts/orchestrator/gate.js';

describe('Codex gate', () => {
  it('uses the Review route and does not pass GitHub credentials to Codex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-gate-test-'));
    const repo = join(dir, 'repo');
    const oldModel = process.env.FAIR_MODEL_CONFIG;
    const oldToken = process.env.GH_TOKEN;
    try {
      execFileSync('/usr/bin/git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'README.md'), 'fixture');
      execFileSync('/usr/bin/git', ['-C', repo, 'add', 'README.md']);
      execFileSync('/usr/bin/git', [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@invalid.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      const head = execFileSync(
        '/usr/bin/git',
        ['-C', repo, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      const specSha = execFileSync(
        '/usr/bin/git',
        ['-C', repo, 'hash-object', '-w', '--stdin'],
        { input: 'Approved fixture spec', encoding: 'utf8' },
      ).trim();
      const modelFile = join(dir, 'models.conf');
      writeFileSync(
        modelFile,
        'IMPLEMENTATION_MODEL=gpt-6-sol\nIMPLEMENTATION_EFFORT=low\nREVIEW_MODEL=gpt-6-sol\nREVIEW_EFFORT=low\nQA_MODEL=gpt-6-luna\nQA_EFFORT=low\nLAB_MODEL=gpt-6-luna\nLAB_EFFORT=low\nREPLAY_MODEL=gpt-6-luna\nREPLAY_EFFORT=low\nFALLBACK_MODEL=gpt-6-luna\nFALLBACK_EFFORT=low\nREPORT_MODEL=gpt-6-luna\nREPORT_EFFORT=none\n',
      );
      const fake = join(dir, 'fake-codex');
      writeFileSync(
        fake,
        '#!/bin/sh\n[ -z "$GH_TOKEN" ] || exit 22\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-m" ]; then shift; [ "$1" = "gpt-6-sol" ] || exit 23; fi; if [ "$1" = "-o" ]; then shift; printf \'{"verdict":"PASS","evidenceId":"review-test"}\' > "$1"; exit 0; fi; shift; done\nexit 24\n',
      );
      chmodSync(fake, 0o700);
      process.env.FAIR_MODEL_CONFIG = modelFile;
      process.env.GH_TOKEN = 'must-not-leak';
      const output = executeCodexGate('REVIEW', {
        taskId: 53,
        attempt: 1,
        idempotencyKey: '53:1:REVIEW',
        specPath: 'docs/tasks/TASK.md',
        specSha,
        baseSha: head,
        headSha: head,
        gate: 'REVIEW',
        worktree: repo,
        sourceRepo: repo,
        codexExecutable: fake,
      });
      expect(output.verdict).toBe('PASS');
      expect(output.sha).toBe(head);
    } finally {
      if (oldModel === undefined) delete process.env.FAIR_MODEL_CONFIG;
      else process.env.FAIR_MODEL_CONFIG = oldModel;
      if (oldToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = oldToken;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

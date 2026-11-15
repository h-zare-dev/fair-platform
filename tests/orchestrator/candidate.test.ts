import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidate } from '../../scripts/orchestrator/candidate.js';

describe('merge candidate', () => {
  it('creates an exact two-parent candidate and tests its detached tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fair-candidate-'));
    const repo = join(dir, 'repo');
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', repo, ...args], {
        encoding: 'utf8',
      }).trim();
    try {
      execFileSync('/usr/bin/git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'base.txt'), 'base');
      git(['add', '.']);
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@invalid.local',
        'commit',
        '-qm',
        'base',
      ]);
      const common = git(['rev-parse', 'HEAD']);
      git(['switch', '-qc', 'feature']);
      writeFileSync(join(repo, 'feature.txt'), 'feature');
      git(['add', '.']);
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@invalid.local',
        'commit',
        '-qm',
        'feature',
      ]);
      const head = git(['rev-parse', 'HEAD']);
      git(['switch', '-q', '-']);
      writeFileSync(join(repo, 'development.txt'), 'development');
      git(['add', '.']);
      git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@invalid.local',
        'commit',
        '-qm',
        'development',
      ]);
      const base = git(['rev-parse', 'HEAD']);
      expect(base).not.toBe(common);
      const fake = join(dir, 'fake-pnpm');
      writeFileSync(fake, '#!/bin/sh\nexit 0\n');
      chmodSync(fake, 0o700);
      const result = buildCandidate({
        taskId: 57,
        attempt: 1,
        baseSha: base,
        headSha: head,
        idempotencyKey: '57:1:CANDIDATE',
        sourceRepo: repo,
        candidateWorktree: join(dir, 'candidate'),
        pnpmExecutable: fake,
      });
      expect(result.verdict).toBe('PASS');
      expect(
        git(['rev-list', '--parents', '-n', '1', result.candidateSha!])
          .split(' ')
          .slice(1),
      ).toEqual([base, head]);
      expect(
        git(['-C', join(dir, 'candidate'), 'ls-files'])
          .split('\n')
          .sort(),
      ).toEqual(['base.txt', 'development.txt', 'feature.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

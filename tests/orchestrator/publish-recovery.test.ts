import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isReceiptProvenPublishedHead,
  receiptFor,
} from '../../scripts/orchestrator/runner.js';
import { newTask } from '../../scripts/orchestrator/state.js';

const sha = (digit: string): string => digit.repeat(40);

describe('published Implementation restart reconciliation', () => {
  it('recognizes a newer remote PR HEAD only with the immutable receipt and matching worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-publish-resume-'));
    const implementation = join(root, 'impl');
    const evidenceDir = join(root, 'evidence');
    try {
      mkdirSync(implementation);
      mkdirSync(evidenceDir);
      execFileSync('/usr/bin/git', ['init', '-q', implementation]);
      writeFileSync(join(implementation, 'fixture.txt'), 'finished code\n');
      execFileSync('/usr/bin/git', [
        '-C',
        implementation,
        'add',
        'fixture.txt',
      ]);
      execFileSync('/usr/bin/git', [
        '-C',
        implementation,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-q',
        '-m',
        'finished',
      ]);
      const head = execFileSync(
        '/usr/bin/git',
        ['-C', implementation, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      const state = newTask(59, 'docs/tasks/TASK-59.md', sha('a'), sha('b'));
      state.phase = 'IMPLEMENTING';
      state.attempt = 4;
      state.headSha = sha('c');
      state.prNumber = 60;
      const key = `59:4:IMPLEMENTATION:${state.headSha}:-`;
      state.inFlight = {
        gate: 'IMPLEMENTATION',
        key,
        startedAt: new Date().toISOString(),
      };
      const receipt = receiptFor(state, 'IMPLEMENTATION', key, {
        verdict: 'PASS',
        sha: head,
        evidenceId: head,
      });
      writeFileSync(
        join(
          evidenceDir,
          `${createHash('sha256').update(key).digest('hex')}.json`,
        ),
        JSON.stringify(receipt),
      );
      const config = {
        evidenceDir,
        worktrees: { IMPLEMENTATION: implementation },
      } as Parameters<typeof isReceiptProvenPublishedHead>[0];
      expect(isReceiptProvenPublishedHead(config, state, head)).toBe(true);
      expect(isReceiptProvenPublishedHead(config, state, sha('d'))).toBe(false);
      expect(isReceiptProvenPublishedHead(config, state, state.headSha)).toBe(
        false,
      );
      state.attempt++;
      expect(isReceiptProvenPublishedHead(config, state, head)).toBe(false);
      state.attempt--;
      state.inFlight = undefined;
      expect(isReceiptProvenPublishedHead(config, state, head)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

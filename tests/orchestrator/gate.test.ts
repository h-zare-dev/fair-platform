import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_PRLIMIT_ARGS,
  codexSandboxForGate,
  commitImplementationGateChanges,
  executeCodexGate,
} from '../../scripts/orchestrator/gate.js';

describe('Codex gate', () => {
  it('uses full Codex sandbox access for every role as Owner requested', () => {
    expect(codexSandboxForGate('IMPLEMENTATION')).toBe('danger-full-access');
    expect(codexSandboxForGate('REVIEW')).toBe('danger-full-access');
    expect(codexSandboxForGate('QA')).toBe('danger-full-access');
    expect(() => codexSandboxForGate('CI')).toThrow('Unsupported Codex gate');
  });
  it('commits sandbox edits through the trusted gate, not from Codex', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-commit-boundary-'));
    const source = join(root, 'source');
    const linked = join(root, 'implementation');
    const branch = 'agent/66-68a6b3052084';
    try {
      execFileSync('/usr/bin/git', ['init', '-q', source]);
      writeFileSync(join(source, 'fixture.txt'), 'before\\n');
      execFileSync('/usr/bin/git', ['-C', source, 'add', '.']);
      execFileSync('/usr/bin/git', [
        '-C',
        source,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-qm',
        'base',
      ]);
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', ['-C', linked, ...args], {
          encoding: 'utf8',
        }).trim();
      const base = execFileSync(
        '/usr/bin/git',
        ['-C', source, 'rev-parse', 'HEAD'],
        { encoding: 'utf8' },
      ).trim();
      execFileSync('/usr/bin/git', [
        '-C',
        source,
        'worktree',
        'add',
        '-q',
        '-b',
        branch,
        linked,
        base,
      ]);
      expect(readFileSync(join(linked, '.git'), 'utf8')).toContain('gitdir:');

      // A wrong branch, stale SHA, or no source changes must fail closed.
      writeFileSync(join(linked, 'fixture.txt'), 'first change\\n');
      expect(() =>
        commitImplementationGateChanges(
          linked,
          'agent/66-000000000000',
          base,
          'PASS',
        ),
      ).toThrow('branch changed');
      expect(() =>
        commitImplementationGateChanges(linked, branch, 'a'.repeat(40), 'PASS'),
      ).toThrow('HEAD');
      expect(git('rev-parse', 'HEAD')).toBe(base);

      const passed = commitImplementationGateChanges(
        linked,
        branch,
        base,
        'PASS',
      );
      expect(passed).not.toBe(base);
      expect(git('status', '--porcelain')).toBe('');
      expect(git('log', '-1', '--format=%an <%ae>')).toBe(
        'Fair Platform Agent <fair-platform-agent@users.noreply.github.com>',
      );
      expect(() =>
        commitImplementationGateChanges(linked, branch, passed, 'PASS'),
      ).toThrow('PASS without source changes');

      // A BLOCKED gate must preserve forensic edits without staging them.
      writeFileSync(join(linked, 'fixture.txt'), 'blocked edit\\n');
      expect(
        commitImplementationGateChanges(linked, branch, passed, 'BLOCKED'),
      ).toBe(passed);
      expect(git('rev-parse', 'HEAD')).toBe(passed);
      expect(git('status', '--porcelain')).not.toBe('');

      // A valid FAIL may commit its changes for receipt-backed rework.
      const failed = commitImplementationGateChanges(
        linked,
        branch,
        passed,
        'FAIL',
      );
      expect(failed).not.toBe(passed);
      expect(git('status', '--porcelain')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not impose RLIMIT_AS on Codex', () => {
    expect(CODEX_PRLIMIT_ARGS).toEqual(['--cpu=3600', '--nofile=1024']);
    expect(CODEX_PRLIMIT_ARGS.some((arg) => arg.startsWith('--as'))).toBe(
      false,
    );
  });

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
        '#!/bin/sh\n[ -z "$GH_TOKEN" ] || exit 22\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-m" ]; then shift; [ "$1" = "gpt-6-sol" ] || exit 23; fi; if [ "$1" = "-o" ]; then shift; printf \'{"verdict":"PASS","evidenceId":"review-test","defectCode":null}\' > "$1"; exit 0; fi; shift; done\nexit 24\n',
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
        pnpmExecutable: '/bin/true',
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

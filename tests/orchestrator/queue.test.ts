import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eligibleIssues,
  safeTaskDisposition,
  selectEligibleQueueTask,
  syncApprovedDevelopment,
} from '../../scripts/orchestrator/queue.js';
import { newTask } from '../../scripts/orchestrator/state.js';

describe('queue admission', () => {
  it('fetches only origin/development and verifies the exact remote SHA', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-queue-fetch-'));
    const remote = join(root, 'remote.git');
    const source = join(root, 'source');
    const peer = join(root, 'peer');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
        encoding: 'utf8',
      }).trim();
    const commit = (cwd: string, message: string) => {
      git(cwd, 'add', 'README.md');
      git(
        cwd,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-qm',
        message,
      );
      return git(cwd, 'rev-parse', 'HEAD');
    };
    try {
      execFileSync('/usr/bin/git', ['init', '-q', '--bare', remote]);
      execFileSync('/usr/bin/git', ['init', '-q', '-b', 'development', source]);
      writeFileSync(join(source, 'README.md'), 'base');
      const base = commit(source, 'base');
      git(source, 'remote', 'add', 'origin', remote);
      git(source, 'push', '-q', '-u', 'origin', 'development');
      syncApprovedDevelopment(source, base);

      execFileSync('/usr/bin/git', [
        'clone',
        '-q',
        '-b',
        'development',
        remote,
        peer,
      ]);
      writeFileSync(join(peer, 'README.md'), 'advanced');
      const newer = commit(peer, 'advance remote');
      git(peer, 'push', '-q', 'origin', 'development');
      syncApprovedDevelopment(source, newer);
      expect(git(source, 'rev-parse', 'HEAD')).toBe(base);
      expect(git(source, 'rev-parse', 'origin/development')).toBe(newer);
      expect(() => syncApprovedDevelopment(source, base)).toThrow(
        'QUEUE_DEVELOPMENT_IDENTITY_MISMATCH',
      );
      expect(git(source, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('advances to the next approved task after completion', () => {
    const base = 'b'.repeat(40);
    const spec = 'a'.repeat(40);
    const make = (issue: number) =>
      newTask(
        issue,
        'docs/tasks/OPS-068-durable-agent-queue-resume.md',
        spec,
        base,
      );
    const states = new Map<number, ReturnType<typeof newTask>>();
    states.set(10, make(10));
    states.set(11, make(11));
    const read = (issue: number) => states.get(issue);
    const approve = () => ({ specSha: spec, baseSha: base });
    const select = () =>
      selectEligibleQueueTask([10, 11], base, read, approve, () => false);
    expect(select().issue).toBe(10);
    states.get(10)!.phase = 'DONE';
    expect(select().issue).toBe(11);
    states.get(11)!.phase = 'DONE';
    const finished = select();
    expect(finished.issue).toBeUndefined();
    expect(finished.completed).toBe(true);

    // A stale base or an unresolved historical task cannot be admitted.
    states.get(11)!.phase = 'QUEUED';
    const stale = selectEligibleQueueTask(
      [11],
      'c'.repeat(40),
      read,
      approve,
      () => false,
    );
    expect(stale.issue).toBeUndefined();
    states.get(10)!.phase = 'BLOCKED';
    expect(select().issue).toBe(11);
    expect(select().reconciliation).toBe(true);
  });
  it('sorts and excludes PRs and blocked issues', () => {
    const api = {
      get: () => [
        { number: 9, labels: [{ name: 'agent:approved' }] },
        { number: 3, labels: [{ name: 'agent:approved' }] },
        { number: 4, pull_request: {}, labels: [{ name: 'agent:approved' }] },
        { number: 5, labels: [{ name: 'agent:blocked' }] },
        { number: 6, labels: [] },
      ],
      post: () => ({}),
    };
    expect(eligibleIssues(api)).toEqual([3, 9]);
  });
  it('quarantines all unresolved in-flight and publication checkpoints', () => {
    const task = newTask(
      68,
      'docs/tasks/OPS-068-durable-agent-queue-resume.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    expect(safeTaskDisposition(task)).toBe('resume');
    task.inFlight = { gate: 'IMPLEMENTATION', key: 'key', startedAt: 'now' };
    expect(safeTaskDisposition(task)).toBe('blocked');
    task.inFlight = undefined;
    task.phase = 'READY_FOR_OWNER_REVIEW';
    expect(safeTaskDisposition(task)).toBe('done');
  });
  it('recognizes only an exact Owner-held Draft PR boundary as completed', () => {
    const task = newTask(
      68,
      'docs/tasks/OPS-068-durable-agent-queue-resume.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    task.phase = 'BLOCKED';
    task.headSha = 'c'.repeat(40);
    task.prNumber = 70;
    for (const gate of ['IMPLEMENTATION', 'REVIEW', 'QA'] as const)
      task.verdicts[gate] = {
        verdict: 'PASS',
        sha: task.headSha,
        evidenceId: gate,
      };
    task.transitions.push({
      at: new Date().toISOString(),
      attempt: 1,
      phase: 'BLOCKED',
      actor: 'CI',
      errorCode: 'PILOT_END_BEFORE_CI',
    });
    expect(safeTaskDisposition(task)).toBe('done');
    task.prNumber = undefined;
    expect(safeTaskDisposition(task)).toBe('blocked');
    task.prNumber = 70;
    task.inFlight = { gate: 'QA', key: 'unresolved', startedAt: 'now' };
    expect(safeTaskDisposition(task)).toBe('blocked');
  });
});

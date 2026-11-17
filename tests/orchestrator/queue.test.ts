import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eligibleIssues,
  matchesSupervisedRunnerArguments,
  pendingLaunchStatus,
  safeTaskDisposition,
  selectEligibleQueueTask,
  syncApprovedDevelopment,
  syncApprovedSpec,
} from '../../scripts/orchestrator/queue.js';
import { newTask } from '../../scripts/orchestrator/state.js';
import {
  Orchestrator,
  type Evidence,
  type Ports,
} from '../../scripts/orchestrator/engine.js';

describe('queue admission', () => {
  it('syncs pinned development and spec objects without checkout', () => {
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

      git(peer, 'switch', '-q', '-c', 'spec/fixture');
      const path = 'docs/tasks/OPS-fixture.md';
      mkdirSync(join(peer, 'docs/tasks'), { recursive: true });
      writeFileSync(join(peer, path), '# Pinned fixture');
      git(peer, 'add', path);
      git(
        peer,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-qm',
        'pin spec',
      );
      const specCommit = git(peer, 'rev-parse', 'HEAD');
      const specBlob = git(peer, 'rev-parse', `${specCommit}:${path}`);
      git(peer, 'push', '-q', 'origin', 'spec/fixture');

      syncApprovedSpec(source, specCommit, path, specBlob);
      expect(git(source, 'rev-parse', `${specCommit}:${path}`)).toBe(specBlob);
      expect(git(source, 'rev-parse', 'HEAD')).toBe(base);
      expect(() =>
        syncApprovedSpec(source, specCommit, path, '0'.repeat(40)),
      ).toThrow('QUEUE_SPEC_IDENTITY_MISMATCH');
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
  it('requires a real child runner with exact issue and reservation token', () => {
    const token = 'a'.repeat(64);
    const runner = [
      '/usr/bin/node',
      '/home/test/repo/scripts/orchestrator/dist/supervised.js',
      'run',
      '68',
      token,
    ];
    expect(matchesSupervisedRunnerArguments(runner, 68, token)).toBe(true);
    expect(matchesSupervisedRunnerArguments(runner, 69, token)).toBe(false);
    expect(
      matchesSupervisedRunnerArguments(runner, 68, 'b'.repeat(64)),
    ).toBe(false);
    expect(
      matchesSupervisedRunnerArguments(
        ['/bin/bash', '-c', runner.join(' ')],
        68,
        token,
      ),
    ).toBe(false);
  });
  it('does not claim a live model during tmux startup', () => {
    expect(pendingLaunchStatus(0)).toBe('STARTING');
    expect(pendingLaunchStatus(44_999)).toBe('STARTING');
    expect(pendingLaunchStatus(45_001)).toBe('BLOCKED_RECONCILIATION');
    expect(pendingLaunchStatus(-1)).toBe('BLOCKED_RECONCILIATION');
    expect(pendingLaunchStatus(Number.NaN)).toBe('BLOCKED_RECONCILIATION');
  });
  it('runs two independent synthetic gates and advances', async () => {
    const spec = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    const states = new Map<number, ReturnType<typeof newTask>>();
    const calls: string[] = [];
    const targetSha = new Map([
      [10, 'c'.repeat(40)],
      [11, 'd'.repeat(40)],
    ]);
    const approved = () => ({ specSha: spec, baseSha: base });
    const pick = (numbers: number[]) =>
      selectEligibleQueueTask(
        numbers,
        base,
        (issue) => states.get(issue),
        approved,
        () => false,
      );
    for (const issue of [10, 11]) {
      states.set(
        issue,
        newTask(issue, 'docs/tasks/QUEUE.md', spec, base),
      );
    }
    const ports: Ports = {
      reconcile: () => Promise.resolve(),
      developmentSha: () => Promise.resolve(base),
      report: () => Promise.resolve(),
      publish: (state) => {
        state.prNumber = 100 + state.taskId;
        return Promise.resolve();
      },
      run: (gate, state) => {
        calls.push(`${state.taskId}:${gate}`);
        const evidence: Evidence = {
          verdict: gate === 'CI' ? 'BLOCKED' : 'PASS',
          sha:
            gate === 'IMPLEMENTATION'
              ? targetSha.get(state.taskId)!
              : state.headSha!,
          evidenceId: `${state.taskId}-${gate}`,
          ...(gate === 'CI'
            ? { defectCode: 'PILOT_END_BEFORE_CI' }
            : {}),
        };
        return Promise.resolve(evidence);
      },
    };
    for (const expected of [10, 11]) {
      const next = pick([10, 11]);
      expect(next.issue).toBe(expected);
      const task = next.state!;
      const engine = new Orchestrator(ports, (state) => {
        states.set(state.taskId, state);
      });
      for (let step = 0; step < 8; step++) {
        if (safeTaskDisposition(task) === 'done') break;
        await engine.step(task);
      }
      expect(safeTaskDisposition(task)).toBe('done');
      expect(task.prNumber).toBe(100 + expected);
    }
    expect(pick([10, 11]).issue).toBeUndefined();
    expect(calls).toEqual([
      '10:IMPLEMENTATION',
      '10:REVIEW',
      '10:QA',
      '10:CI',
      '11:IMPLEMENTATION',
      '11:REVIEW',
      '11:QA',
      '11:CI',
    ]);
    states.set(12, newTask(12, 'docs/tasks/QUEUE.md', spec, base));
    expect(pick([10, 11, 12]).issue).toBe(12);
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

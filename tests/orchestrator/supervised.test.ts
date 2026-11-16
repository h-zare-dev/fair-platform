import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allowsInterruptedImplementation,
  allowsReceiptBackedImplementationRework,
  allowsIdleRoleRefresh,
  assertLaunchReservation,
  verifyLaunchHandoff,
  ensurePrivateLockFile,
  parseCommand,
  paths,
} from '../../scripts/orchestrator/supervised.js';
import { newTask } from '../../scripts/orchestrator/state.js';
import {
  runOnce,
  receiptFor,
  usesSupervisedResources,
} from '../../scripts/orchestrator/runner.js';

const launchToken = 'a'.repeat(64);
const reservation = { issue: 59, token: launchToken, session: 'fair-task-59' };

describe('supervised issue identity', () => {
  it('blocks another launch during the detached runner handoff', () => {
    expect(() =>
      assertLaunchReservation('start', 60, reservation, launchToken),
    ).toThrow('pending');
    expect(() =>
      assertLaunchReservation('prepare', 59, reservation, launchToken),
    ).toThrow('pending');
    expect(() =>
      assertLaunchReservation('run', 60, reservation, launchToken),
    ).toThrow('pending');
    expect(() => assertLaunchReservation('run', 59, reservation)).toThrow(
      'pending',
    );
    expect(() =>
      assertLaunchReservation('run', 59, reservation, 'b'.repeat(64)),
    ).toThrow('pending');
    expect(() =>
      assertLaunchReservation('run', 59, reservation, launchToken),
    ).not.toThrow();
    expect(() => verifyLaunchHandoff(reservation, launchToken)).toThrow(
      'tmux runner pane',
    );
  });
  it('requires the lock for an alternate config path using any supervised resource', () => {
    const p = paths(59);
    const outside = join(tmpdir(), 'copied-supervised.json');
    const ordinary = {
      stateFile: join(tmpdir(), 'ordinary-state'),
      evidenceDir: join(tmpdir(), 'ordinary-evidence'),
      candidateWorktree: join(tmpdir(), 'fair-agent-candidate'),
      worktrees: {
        IMPLEMENTATION: join(tmpdir(), 'fair-agent-implementation'),
        REVIEW: join(tmpdir(), 'fair-agent-review'),
        QA: join(tmpdir(), 'fair-agent-qa'),
      },
    };
    expect(usesSupervisedResources(outside, ordinary)).toBe(false);
    for (const path of [
      p.state,
      p.evidence,
      p.candidate,
      ...Object.values(p.worktrees),
    ]) {
      const config = structuredClone(ordinary);
      if (path === p.state) config.stateFile = path;
      else if (path === p.evidence) config.evidenceDir = path;
      else if (path === p.candidate) config.candidateWorktree = path;
      else {
        const role = Object.entries(p.worktrees).find(
          ([, value]) => value === path,
        )![0] as keyof typeof config.worktrees;
        config.worktrees[role] = path;
      }
      expect(usesSupervisedResources(outside, config)).toBe(true);
    }
    expect(
      usesSupervisedResources(
        join(process.env.HOME!, '.config/fair-platform/tasks/../tasks/59.json'),
        ordinary,
      ),
    ).toBe(true);
  });
  it('refuses direct runner entry for supervised task config without global flock', async () => {
    await expect(
      runOnce(
        join(process.env.HOME!, '.config/fair-platform/tasks/99999.json'),
      ),
    ).rejects.toThrow('requires the supervised lock');
  });
  it('refuses a normalized supervised config alias without global flock', async () => {
    await expect(
      runOnce(
        join(
          process.env.HOME!,
          '.config/fair-platform/tasks/../tasks/99999.json',
        ),
      ),
    ).rejects.toThrow('requires the supervised lock');
  });
  it('refuses copied configs pointing to supervised state before contacting GitHub', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-copied-config-'));
    try {
      const model = join(root, 'models');
      writeFileSync(
        model,
        [
          'IMPLEMENTATION_MODEL=gpt-6-sol',
          'IMPLEMENTATION_EFFORT=low',
          'REVIEW_MODEL=gpt-6-sol',
          'REVIEW_EFFORT=low',
          'QA_MODEL=gpt-6-luna',
          'QA_EFFORT=low',
          'LAB_MODEL=gpt-6-luna',
          'LAB_EFFORT=low',
          'REPLAY_MODEL=gpt-6-luna',
          'REPLAY_EFFORT=low',
          'FALLBACK_MODEL=gpt-6-luna',
          'FALLBACK_EFFORT=low',
          'REPORT_MODEL=gpt-6-luna',
          'REPORT_EFFORT=none',
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      const token = join(root, 'token');
      writeFileSync(token, 'fixture', { mode: 0o600 });
      const p = paths(99999);
      const ordinary = {
        issue: 99999,
        ownerLogin: 'h-zare-dev',
        pilotMode: true,
        labActivated: false,
        stateFile: join(root, 'state'),
        evidenceDir: join(root, 'evidence'),
        modelFile: model,
        githubTokenFile: token,
        sourceRepo: root,
        candidateWorktree: join(root, 'fair-agent-candidate'),
        worktrees: {
          IMPLEMENTATION: join(root, 'fair-agent-implementation'),
          REVIEW: join(root, 'fair-agent-review'),
          QA: join(root, 'fair-agent-qa'),
        },
        pnpmExecutable: '/usr/bin/true',
        codexExecutable: '/usr/bin/true',
        ghExecutable: '/usr/bin/true',
        maxModelCallsPerDay: 3,
        commands: Object.fromEntries(
          ['IMPLEMENTATION', 'REVIEW', 'QA'].map((gate) => [
            gate,
            { executable: process.execPath, args: [], timeoutMs: 1000 },
          ]),
        ),
      };
      for (const [name, override] of [
        ['stateFile', { stateFile: p.state }],
        ['evidenceDir', { evidenceDir: p.evidence }],
        ['candidateWorktree', { candidateWorktree: p.candidate }],
        ...Object.entries(p.worktrees).map(([role, path]) => [
          `worktree-${role}`,
          { worktrees: { ...ordinary.worktrees, [role]: path } },
        ]),
      ] as [string, object][]) {
        const config = join(root, `${name}.json`);
        writeFileSync(config, JSON.stringify({ ...ordinary, ...override }), {
          mode: 0o600,
        });
        await expect(runOnce(config)).rejects.toThrow(
          'requires the supervised lock',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps a pending handoff reserved against a direct runner holding the flock', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-pending-handoff-'));
    try {
      const privateRoot = join(root, '.local/state/fair-platform');
      const taskRoot = join(privateRoot, 'tasks/60');
      mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
      const lock = join(privateRoot, 'supervised.lock');
      const launch = join(privateRoot, 'supervised.launch');
      writeFileSync(lock, '', { mode: 0o600 });
      const saved = JSON.stringify(reservation);
      writeFileSync(launch, saved, { mode: 0o600 });
      const model = join(root, 'models');
      writeFileSync(
        model,
        [
          'IMPLEMENTATION_MODEL=gpt-6-sol',
          'IMPLEMENTATION_EFFORT=low',
          'REVIEW_MODEL=gpt-6-sol',
          'REVIEW_EFFORT=low',
          'QA_MODEL=gpt-6-luna',
          'QA_EFFORT=low',
          'LAB_MODEL=gpt-6-luna',
          'LAB_EFFORT=low',
          'REPLAY_MODEL=gpt-6-luna',
          'REPLAY_EFFORT=low',
          'FALLBACK_MODEL=gpt-6-luna',
          'FALLBACK_EFFORT=low',
          'REPORT_MODEL=gpt-6-luna',
          'REPORT_EFFORT=none',
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
      const token = join(root, 'token');
      writeFileSync(token, 'fixture', { mode: 0o600 });
      const task = join(root, 'task');
      const command = {
        executable: process.execPath,
        args: [],
        timeoutMs: 1000,
      };
      const config = join(root, 'copied.json');
      writeFileSync(
        config,
        JSON.stringify({
          issue: 60,
          ownerLogin: 'h-zare-dev',
          pilotMode: true,
          labActivated: false,
          stateFile: join(taskRoot, 'state.json'),
          evidenceDir: join(taskRoot, 'evidence'),
          modelFile: model,
          githubTokenFile: token,
          sourceRepo: root,
          candidateWorktree: join(task, 'fair-agent-candidate'),
          worktrees: {
            IMPLEMENTATION: join(task, 'fair-agent-implementation'),
            REVIEW: join(task, 'fair-agent-review'),
            QA: join(task, 'fair-agent-qa'),
          },
          pnpmExecutable: '/usr/bin/true',
          codexExecutable: '/usr/bin/true',
          ghExecutable: '/usr/bin/true',
          maxModelCallsPerDay: 3,
          commands: { IMPLEMENTATION: command, REVIEW: command, QA: command },
        }),
        { mode: 0o600 },
      );
      for (const issue of [60, 59]) {
        const configured = JSON.parse(readFileSync(config, 'utf8')) as Record<
          string,
          unknown
        >;
        configured.issue = issue;
        writeFileSync(config, JSON.stringify(configured), { mode: 0o600 });
        const result = spawnSync(
          '/usr/bin/flock',
          [
            '-n',
            lock,
            process.execPath,
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            "import { runOnce } from './scripts/orchestrator/runner.ts'; await runOnce(process.argv[1]);",
            config,
          ],
          {
            env: { ...process.env, HOME: root, FAIR_SUPERVISED_LOCKED: '1' },
            encoding: 'utf8',
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('A supervised launch is pending');
        expect(readFileSync(launch, 'utf8')).toBe(saved);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('recovers only a verified failed Implementation commit on the next rework', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-failed-implementation-'));
    const worktree = join(root, 'repo');
    const evidenceDir = join(root, 'evidence');
    mkdirSync(worktree);
    mkdirSync(evidenceDir);
    try {
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', ['-C', worktree, ...args], {
          encoding: 'utf8',
        }).trim();
      git('init', '-q');
      writeFileSync(join(worktree, 'fixture.txt'), 'base\n');
      git('add', 'fixture.txt');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-qm',
        'base',
      );
      const baseSha = git('rev-parse', 'HEAD');
      writeFileSync(join(worktree, 'fixture.txt'), 'failed attempt\n');
      git('add', 'fixture.txt');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '-qm',
        'failed implementation',
      );
      const failedSha = git('rev-parse', 'HEAD');

      const state = newTask(
        59,
        'docs/tasks/example.md',
        'a'.repeat(40),
        baseSha,
      );
      const evidence = {
        verdict: 'FAIL' as const,
        sha: failedSha,
        evidenceId: 'failed-implementation-1',
        defectCode: 'INCOMPLETE',
      };
      const key = `59:1:IMPLEMENTATION:${baseSha}:-`;
      const receipt = receiptFor(state, 'IMPLEMENTATION', key, evidence);
      const receiptPath = join(
        evidenceDir,
        `${createHash('sha256').update(key).digest('hex')}.json`,
      );
      writeFileSync(receiptPath, JSON.stringify(receipt));

      state.phase = 'REWORK';
      state.attempt = 2;
      state.reworks = 1;
      state.transitions.push({
        at: new Date().toISOString(),
        phase: 'REWORK',
        actor: 'orchestrator',
        attempt: 2,
        evidenceId: evidence.evidenceId,
        errorCode: evidence.defectCode,
      });
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(true);

      state.phase = 'IMPLEMENTING';
      state.transitions.push({
        at: new Date().toISOString(),
        phase: 'IMPLEMENTING',
        actor: 'orchestrator',
        attempt: 2,
      });
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(true);

      // A wrong receipt or a different failed attempt must not authorize
      // divergence from the saved implementation SHA.
      writeFileSync(
        receiptPath,
        JSON.stringify({
          ...receipt,
          evidence: { ...evidence, sha: '0'.repeat(40) },
        }),
      );
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(false);

      writeFileSync(receiptPath, JSON.stringify(receipt));
      state.transitions[0]!.evidenceId = 'different-failed-gate';
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(false);

      // A persisted FAIL pending-report checkpoint is also recoverable.
      state.transitions = [];
      state.phase = 'IMPLEMENTING';
      state.attempt = 1;
      state.pendingReport = { gate: 'IMPLEMENTATION', key, evidence };
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(true);
      state.pendingReport = undefined;
      expect(
        allowsReceiptBackedImplementationRework(
          state,
          worktree,
          evidenceDir,
          failedSha,
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('allows only an in-flight Implementation worktree through receipt recovery', () => {
    const state = newTask(
      59,
      'docs/tasks/example.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    expect(allowsInterruptedImplementation(state, 'IMPLEMENTATION')).toBe(
      false,
    );
    state.inFlight = {
      gate: 'IMPLEMENTATION',
      key: 'receipt-key',
      startedAt: new Date().toISOString(),
    };
    expect(allowsInterruptedImplementation(state, 'IMPLEMENTATION')).toBe(true);
    expect(allowsInterruptedImplementation(state, 'REVIEW')).toBe(false);
    state.inFlight.gate = 'REVIEW';
    expect(allowsInterruptedImplementation(state, 'IMPLEMENTATION')).toBe(
      false,
    );
  });
  it('allows a clean idle Review worktree to be refreshed for the next SHA', () => {
    const state = newTask(
      62,
      'docs/tasks/example.md',
      'a'.repeat(40),
      'b'.repeat(40),
    );
    state.phase = 'REVIEWING';
    state.headSha = 'c'.repeat(40);
    expect(allowsIdleRoleRefresh(state, 'REVIEW')).toBe(true);
    expect(allowsIdleRoleRefresh(state, 'QA')).toBe(true);
    expect(allowsIdleRoleRefresh(state, 'IMPLEMENTATION')).toBe(false);
    state.inFlight = {
      gate: 'REVIEW',
      key: 'receipt-key',
      startedAt: new Date().toISOString(),
    };
    expect(allowsIdleRoleRefresh(state, 'REVIEW')).toBe(false);
  });
  it('creates the supervised flock file privately before starting a runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-lock-private-'));
    const lock = join(root, 'private', 'supervised.lock');
    try {
      ensurePrivateLockFile(lock);
      expect(statSync(lock).mode & 0o077).toBe(0);
      // Repeated calls preserve the same lock file rather than replacing
      // the inode under an existing OS flock.
      const first = statSync(lock).ino;
      ensurePrivateLockFile(lock);
      expect(statSync(lock).ino).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a forged internal-run environment flag without a real flock', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/orchestrator/supervised.ts'),
        'internal-run',
        '62',
      ],
      { env: { ...process.env, FAIR_SUPERVISED_LOCKED: '1' } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain('requires the supervised lock');
  });
  it('refuses a direct internal run before approval or side effects', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/orchestrator/supervised.ts'),
        'internal-run',
        '59',
      ],
      { env: { ...process.env, FAIR_SUPERVISED_LOCKED: '' } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain('requires the supervised lock');
  });
  it('accepts one explicit positive issue', () => {
    expect(parseCommand(['preflight', '59'])).toEqual({
      command: 'preflight',
      issue: 59,
    });
    expect(parseCommand(['run', '123']).issue).toBe(123);
    expect(parseCommand(['start', '62'])).toEqual({
      command: 'start',
      issue: 62,
    });
  });
  it.each([
    [],
    ['run'],
    ['run', '0'],
    ['run', '-1'],
    ['run', '1', '2'],
    ['run', '01'],
    ['run', '1.0'],
    ['run', '57'],
    ['run', '9007199254740992'],
    ['poll', '59'],
    ['run', '1;id'],
  ])('rejects malformed or unauthorized input: %j', (...input) => {
    expect(() => parseCommand(input)).toThrow();
  });
  it('isolates every issue from the legacy pilot and other issues', () => {
    const a = paths(59);
    const b = paths(60);
    expect(a.config).not.toBe(b.config);
    expect(a.state).not.toBe(b.state);
    expect(a.evidence).not.toBe(b.evidence);
    expect(
      Object.values(a.worktrees).every((path) => path.includes('/59/')),
    ).toBe(true);
    expect(JSON.stringify(a)).not.toContain('pilot.json');
    expect(JSON.stringify(a)).not.toContain('/57/');
  });
});

describe('task tmux wrapper', () => {
  it('reports a live runner shell as running', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-supervised-status-'));
    const shell = spawn(
      '/bin/bash',
      ['-c', 'sleep 30; : # supervised.js run '],
      {
        stdio: 'ignore',
      },
    );
    try {
      const state = join(root, 'state.json');
      const pid = join(root, 'runner.pid');
      writeFileSync(state, JSON.stringify({ phase: 'IMPLEMENTING' }));
      writeFileSync(pid, String(shell.pid));
      const output = execFileSync(
        '/bin/bash',
        [resolve('scripts/orchestrator/supervised-status.sh'), state, pid],
        { encoding: 'utf8' },
      );
      expect(output).toContain(`RUNNING PID=${shell.pid}`);
    } finally {
      shell.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports saved in-flight state without claiming a live runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-supervised-status-'));
    try {
      const state = join(root, 'state.json');
      writeFileSync(
        state,
        JSON.stringify({
          phase: 'IMPLEMENTING',
          headSha: 'a'.repeat(40),
          inFlight: { gate: 'IMPLEMENTATION' },
        }),
      );
      const output = execFileSync(
        '/bin/bash',
        [
          resolve('scripts/orchestrator/supervised-status.sh'),
          state,
          join(root, 'runner.pid'),
        ],
        { encoding: 'utf8' },
      );
      expect(output).toContain('STOPPED');
      expect(output).toContain('IN_FLIGHT_UNVERIFIED=IMPLEMENTATION');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not mistake an unrelated live PID for the task runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-supervised-status-'));
    try {
      const state = join(root, 'state.json');
      const pid = join(root, 'runner.pid');
      writeFileSync(state, JSON.stringify({ phase: 'REVIEWING' }));
      writeFileSync(pid, String(process.pid));
      const output = execFileSync(
        '/bin/bash',
        [resolve('scripts/orchestrator/supervised-status.sh'), state, pid],
        { encoding: 'utf8' },
      );
      expect(output).toContain('STOPPED');
      expect(output).not.toContain('RUNNING PID=');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('launches exactly one task session with an authenticated token', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-supervised-'));
    try {
      const bin = join(root, 'bin');
      const configDir = join(root, '.config/fair-platform/tasks');
      const stateDir = join(root, 'state');
      mkdirSync(bin);
      mkdirSync(configDir, { recursive: true });
      mkdirSync(stateDir);
      writeFileSync(join(configDir, '59.json'), '{}');
      writeFileSync(
        join(bin, 'tmux'),
        '#!/bin/sh\nif [ "$1" = has-session ]; then exit 1; fi\nprintf "%s\\n" "$1" >> "$HOME/tmux-calls"\n',
        { mode: 0o755 },
      );
      execFileSync(
        '/bin/bash',
        [
          resolve('scripts/orchestrator/supervised-tmux.sh'),
          '59',
          '/tmp/supervised.js',
          join(stateDir, 'state.json'),
          launchToken,
        ],
        {
          env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
        },
      );
      expect(
        readFileSync(join(root, 'tmux-calls'), 'utf8').trim().split('\n'),
      ).toEqual(['new-session', 'new-window', 'new-window']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses an already running task session', () => {
    const root = mkdtempSync(join(tmpdir(), 'fair-supervised-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = spawnSync(
        '/bin/bash',
        [
          resolve('scripts/orchestrator/supervised-tmux.sh'),
          '59',
          '/tmp/supervised.js',
          join(root, 'state.json'),
          launchToken,
        ],
        {
          env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
        },
      );
      expect(result.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

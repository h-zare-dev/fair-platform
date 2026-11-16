import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseCommand, paths } from '../../scripts/orchestrator/supervised.js';

describe('supervised issue identity', () => {
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
  it('launches exactly one task session with the documented four arguments', () => {
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

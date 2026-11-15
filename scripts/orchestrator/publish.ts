import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSha } from './state.js';

export function publishHead(
  worktree: string,
  branch: string,
  sha: string,
  token: string,
): void {
  if (
    !worktree.startsWith('/') ||
    !/^agent\/[a-z0-9-]{1,80}$/.test(branch) ||
    !isSha(sha) ||
    !token
  )
    throw new Error('Invalid publish request');
  const local = execFileSync(
    '/usr/bin/git',
    ['-C', worktree, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  if (local !== sha)
    throw new Error('Implementation HEAD changed before publication');
  const temp = mkdtempSync(join(tmpdir(), 'fair-git-auth-'));
  const askpass = join(temp, 'askpass');
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *Password*) printf %s "$GH_TOKEN";; esac\n',
    { mode: 0o700 },
  );
  try {
    execFileSync(
      '/usr/bin/git',
      ['-C', worktree, 'push', 'origin', `HEAD:refs/heads/${branch}`],
      {
        timeout: 120_000,
        stdio: 'pipe',
        env: {
          HOME: process.env.HOME ?? '',
          PATH: '/usr/bin:/bin',
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: '0',
          GH_TOKEN: token,
        },
      },
    );
  } catch {
    throw new Error('Feature branch publication failed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

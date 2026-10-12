import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { syntheticReplay, syntheticLine } from '../helpers/replay.js';
import { fixture } from '../helpers/fixtures.js';
import { object } from '../../scripts/replay/json.js';

const execute = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const cli = resolve('scripts/replay/cli.ts');
const environment = {
  ...process.env,
  DEBUG: '',
  TESTCONTAINERS_DEBUG: '',
  DATABASE_URL: 'postgres://forbidden.invalid/production',
};

describe('standalone historical replay CLI', () => {
  it('uses a disposable database, reports Actor-null validation, repeats import, and exits successfully without financial activation', async () => {
    const files = await syntheticReplay([
      syntheticLine([
        { ...fixture(), by: { id: null, username: 'synthetic-private-actor' } },
      ]),
    ]);
    cleanups.push(files.cleanup);
    const out = join(files.directory, 'summary.json');
    const result = await execute(
      'pnpm',
      [
        'exec',
        'tsx',
        cli,
        '--input',
        files.input,
        '--manifest',
        files.manifest,
        '--out',
        out,
        '--offline-disposable',
        '--repeat',
      ],
      { env: environment, timeout: 120000 },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Replay PASS');
    expect(result.stdout).not.toContain('synthetic-private-actor');
    const report: unknown = JSON.parse(await readFile(out, 'utf8'));
    expect(report).toMatchObject({
      schema_version: 1,
      status: 'PASS',
      first: { events: 0, rejectedChildren: 1, actorNull: { rejected: 1 } },
      differences: {
        repeatNewEvents: 0,
        repeatNewBatches: 0,
        repeatNewIssues: 0,
      },
    });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  }, 120000);
  it('exits nonzero with only a fixed code on tampered input and removes the incomplete report', async () => {
    const files = await syntheticReplay();
    cleanups.push(files.cleanup);
    await writeFile(files.input, 'synthetic-private-tampering');
    const out = join(files.directory, 'summary.json');
    try {
      await execute(
        'pnpm',
        [
          'exec',
          'tsx',
          cli,
          '--input',
          files.input,
          '--manifest',
          files.manifest,
          '--out',
          out,
          '--offline-disposable',
        ],
        { env: environment, timeout: 120000 },
      );
      expect.fail('Expected nonzero CLI exit');
    } catch (error) {
      expect(object(error)).toBe(true);
      if (!object(error)) throw error;
      expect(error.code).toBe(1);
      expect(error.stderr).toBe('CHECKSUM_MISMATCH\n');
      expect(error.stdout).toBe('');
    }
    await expect(stat(out)).rejects.toHaveProperty('code', 'ENOENT');
  }, 120000);
});

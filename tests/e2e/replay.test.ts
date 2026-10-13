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
const cli = resolve('scripts/replay/dist/cli.js');
const environment = {
  ...process.env,
  DEBUG: '',
  TESTCONTAINERS_DEBUG: '',
  DATABASE_URL: 'postgres://forbidden.invalid/production',
};

async function subprocess(command: string, args: string[]) {
  try {
    return {
      ...(await execute(command, args, { env: environment, timeout: 120000 })),
      code: 0,
    };
  } catch (error) {
    if (
      !object(error) ||
      typeof error.code !== 'number' ||
      typeof error.stdout !== 'string' ||
      typeof error.stderr !== 'string'
    )
      throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function argumentsFor(input: string, manifest: string, out: string) {
  return [
    '--input',
    input,
    '--manifest',
    manifest,
    '--out',
    out,
    '--offline-disposable',
  ];
}

function expectPrivateStreams(
  result: { stdout: string; stderr: string },
  paths: string[],
) {
  for (const stream of [result.stdout, result.stderr]) {
    for (const path of paths) expect(stream).not.toContain(path);
    expect(stream).not.toContain('synthetic-private-actor');
  }
}

describe('standalone compiled historical replay CLI', () => {
  it('uses a disposable database, reports Actor-null validation, repeats import, and keeps both output streams private', async () => {
    const files = await syntheticReplay([
      syntheticLine(
        [
          {
            ...fixture(),
            by: { id: null, username: 'synthetic-private-actor' },
          },
        ],
        '2026-01-15 12:00:00.123456+00:00',
      ),
    ]);
    cleanups.push(files.cleanup);
    await files.writeManifest({
      ...files.metadata,
      cutoff_utc: '2026-01-16T00:00:00+00:00',
    });
    const out = join(files.directory, 'summary.json');
    const result = await subprocess(process.execPath, [
      cli,
      ...argumentsFor(files.input, files.manifest, out),
      '--repeat',
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Replay PASS');
    expectPrivateStreams(result, [
      files.directory,
      files.input,
      files.manifest,
      out,
    ]);
    const report: unknown = JSON.parse(await readFile(out, 'utf8'));
    expect(report).toMatchObject({
      schema_version: 1,
      status: 'PASS',
      input: { receiptPrecisionTruncated: 1 },
      first: { events: 1, rejectedChildren: 0, actorNull: { accepted: 1 } },
      differences: {
        repeatNewEvents: 0,
        repeatNewBatches: 0,
        repeatNewIssues: 0,
      },
    });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  }, 120000);

  it.each(['existing output', 'tampered input', 'invalid manifest'])(
    'keeps both streams private on %s and preserves filesystem protections',
    async (scenario) => {
      const files = await syntheticReplay();
      cleanups.push(files.cleanup);
      const out = join(files.directory, 'summary.json');
      if (scenario === 'existing output') await writeFile(out, 'preserve me');
      if (scenario === 'tampered input')
        await writeFile(files.input, 'synthetic-private-tampering');
      if (scenario === 'invalid manifest')
        await writeFile(files.manifest, '{"manifest_version": 1}');
      const result = await subprocess(process.execPath, [
        cli,
        ...argumentsFor(files.input, files.manifest, out),
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        scenario === 'existing output'
          ? 'OUTPUT_FAILED\n'
          : scenario === 'tampered input'
            ? 'CHECKSUM_MISMATCH\n'
            : 'INVALID_MANIFEST\n',
      );
      expectPrivateStreams(result, [
        files.directory,
        files.input,
        files.manifest,
        out,
      ]);
      if (scenario === 'existing output')
        expect(await readFile(out, 'utf8')).toBe('preserve me');
      else await expect(stat(out)).rejects.toHaveProperty('code', 'ENOENT');
    },
    120000,
  );

  it('reproduces pnpm script argument disclosure with synthetic paths even before replay starts', async () => {
    const files = await syntheticReplay();
    cleanups.push(files.cleanup);
    const out = join(files.directory, 'summary.json');
    await writeFile(out, 'preserve me');
    // Recreate the removed launcher outside the repository. Its implementation
    // invokes Node directly: pnpm itself still echoes every supplied argument.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      join(files.directory, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          'replay:historical': `${quote(process.execPath)} ${quote(cli)}`,
        },
      }),
    );
    const result = await subprocess('pnpm', [
      '--dir',
      files.directory,
      'run',
      'replay:historical',
      ...argumentsFor(files.input, files.manifest, out),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OUTPUT_FAILED');
    const combined = result.stdout + result.stderr;
    for (const path of [files.input, files.manifest, out])
      expect(combined).toContain(path);
    expect(await readFile(out, 'utf8')).toBe('preserve me');
  }, 120000);
});

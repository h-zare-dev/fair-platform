import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fail, safeCode } from './errors.js';
import { outsideWorktree } from './paths.js';
import { runReplay } from './runner.js';

export function argumentsFor(args: string[]) {
  try {
    const { values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        input: { type: 'string' },
        manifest: { type: 'string' },
        out: { type: 'string' },
        'offline-disposable': { type: 'boolean' },
        repeat: { type: 'boolean' },
      },
    });
    if (
      !values.input ||
      !values.manifest ||
      values['offline-disposable'] !== true ||
      values.out === ''
    )
      fail('INVALID_ARGUMENTS');
    return {
      input: values.input,
      manifest: values.manifest,
      out: values.out,
      repeat: values.repeat ?? false,
    };
  } catch {
    return fail('INVALID_ARGUMENTS');
  }
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  let output: string | undefined;
  let written = false;
  let directory: string | undefined;
  try {
    const options = argumentsFor(args);
    // Testcontainers uses DEBUG to expose transport details. Refuse verbose diagnostics for private replay.
    if (process.env.DEBUG || process.env.TESTCONTAINERS_DEBUG)
      fail('INVALID_ARGUMENTS');
    if (!options.out)
      directory = await mkdtemp(resolve(tmpdir(), 'fair-replay-report-'));
    output = await outsideWorktree(
      options.out ?? resolve(directory!, 'report.json'),
      true,
    );
    try {
      destination = await open(output, 'wx', 0o600);
    } catch {
      fail('OUTPUT_FAILED');
    }
    const report = await runReplay(
      options.input,
      options.manifest,
      options.repeat,
    );
    await destination.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    written = true;
    // Do not print input/output paths, checksums, cutoffs, identities, or arbitrary errors.
    console.log(
      `Replay ${report.status}: ${report.input.legacyGroups} source groups, ${report.first.batches} stored batches, ${report.first.events} normalized events, ${report.first.rejectedChildren} rejected children. Private aggregate JSON report written.`,
    );
    return report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(safeCode(error));
    return 1;
  } finally {
    await destination?.close();
    if (output && !written && destination) await rm(output, { force: true });
    if (directory && !written)
      await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('CLEANUP_FAILED');
      process.exitCode = 1;
    },
  );
}

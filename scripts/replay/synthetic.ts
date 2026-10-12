import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { object } from './json.js';

/** Explicit synthetic-only demo generator; never reads user-supplied files. */
async function generate(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fair-synthetic-replay-'));
  const child: unknown = JSON.parse(
    await readFile(
      resolve('tests/fixtures/pasarguard/single-event.sanitized.json'),
      'utf8',
    ),
  );
  if (!object(child) || typeof child.action !== 'string')
    throw new Error('SYNTHETIC_FIXTURE_INVALID');
  const gzip = gzipSync(
    JSON.stringify({
      received_at: '2026-01-15T12:00:00.123456Z',
      legacy_stored_rows: 1,
      payload: [child],
    }) + '\n',
  );
  await writeFile(join(directory, 'synthetic.jsonl.gz'), gzip, { mode: 0o600 });
  await writeFile(
    join(directory, 'synthetic.manifest.json'),
    JSON.stringify(
      {
        manifest_version: 1,
        source: 'legacy-pasarjew-postgresql',
        window_days: 1,
        cutoff_utc: '2026-01-16T00:00:00Z',
        distinct_payload_groups: 1,
        legacy_stored_rows: 1,
        replay_event_children: 1,
        groups_with_repetition_mismatch: 0,
        actor_object_null_id_events: 0,
        action_counts: { [child.action]: 1 },
        sha256_gzip: createHash('sha256').update(gzip).digest('hex'),
        notes:
          'Fully synthetic demo; generated from the committed FP-001 synthetic fixture.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(`Synthetic demo files: ${directory}`);
}
void generate().catch(() => {
  console.error('SYNTHETIC_FIXTURE_FAILED');
  process.exitCode = 1;
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fixture } from './fixtures.js';
import type { Manifest } from '../../scripts/replay/manifest.js';
import { actorNull, actionOf, object } from '../../scripts/replay/json.js';

export interface SyntheticLine {
  received_at: string;
  legacy_stored_rows: number;
  payload: Record<string, unknown>[];
}
export function syntheticLine(
  payload = [fixture()],
  received_at = '2026-01-15 12:00:00.123456+00',
): SyntheticLine {
  return { received_at, legacy_stored_rows: payload.length, payload };
}
export async function syntheticReplay(
  lines = [syntheticLine()],
  versioned = true,
) {
  const directory = await mkdtemp(join(tmpdir(), 'fair-synthetic-replay-'));
  const input = join(directory, 'synthetic.jsonl.gz');
  const manifest = join(directory, 'synthetic.manifest.json');
  const gzip = gzipSync(
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  const actions = Object.create(null) as Record<string, number>;
  let actor = 0;
  for (const line of lines)
    for (const child of line.payload) {
      if (!object(child)) continue;
      const action = actionOf(child);
      actions[action] = (actions[action] ?? 0) + 1;
      if (actorNull(child)) actor++;
    }
  const metadata: Manifest = {
    ...(versioned ? { manifest_version: 1 as const } : {}),
    source: 'legacy-pasarjew-postgresql',
    window_days: 1,
    cutoff_utc: '2026-01-16T00:00:00Z',
    distinct_payload_groups: lines.length,
    legacy_stored_rows: lines.reduce(
      (sum, line) => sum + line.legacy_stored_rows,
      0,
    ),
    replay_event_children: lines.reduce(
      (sum, line) => sum + line.payload.length,
      0,
    ),
    groups_with_repetition_mismatch: lines.filter(
      (line) => line.legacy_stored_rows !== line.payload.length,
    ).length,
    actor_object_null_id_events: actor,
    action_counts: actions,
    sha256_gzip: createHash('sha256').update(gzip).digest('hex'),
  };
  await writeFile(input, gzip, { mode: 0o600 });
  await writeFile(manifest, JSON.stringify(metadata), { mode: 0o600 });
  return {
    directory,
    input,
    manifest,
    metadata,
    gzip,
    writeManifest: (value: unknown) =>
      writeFile(manifest, JSON.stringify(value)),
    writeInput: async (text: string | Buffer, compress = true) => {
      const bytes = compress ? gzipSync(text) : Buffer.from(text);
      metadata.sha256_gzip = createHash('sha256').update(bytes).digest('hex');
      await writeFile(input, bytes);
      await writeFile(manifest, JSON.stringify(metadata));
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

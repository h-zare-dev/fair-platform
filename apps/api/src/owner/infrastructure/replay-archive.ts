import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { outsideWorktree } from '@fair-platform/pasarguard/infrastructure/replay/paths';
import type { DataSource } from 'typeorm';
import {
  localJalaliDate,
  jalaliLocalMidnightUtc,
} from '@fair-platform/calendar';
import {
  DurableInbox,
  PayloadEncryption,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { ReplayInput } from '@fair-platform/pasarguard/infrastructure/replay/input';

export const MAX_ARCHIVE_EVENTS = 400000;
const DAY = 86400000;

// The ingestion fingerprint includes the import source identifier. These
// fields identify review evidence across exports made with the same aliases.
export const replayReviewFingerprintSql = `encode(sha256(convert_to(jsonb_build_array(
  action, billing_admin_id, external_user_id, source_enqueued_at AT TIME ZONE 'UTC',
  user_status, data_limit_bytes, used_traffic_bytes, reset_strategy,
  on_hold_expire_duration_seconds, source_user_expire_at AT TIME ZONE 'UTC'
)::text, 'UTF8')), 'hex')`;

export async function readReplayReviewKeys(
  archivePath: string,
): Promise<string[]> {
  const path = archivePath.replace(/\.jsonl\.gz$/, '.review.json');
  if (path === archivePath) throw new Error('REPLAY_ARCHIVE_FILENAME');
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const file = await open(
    await outsideWorktree(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const maxBytes = 128 * 1024;
    const buffer = Buffer.alloc(maxBytes + 1);
    if (!(await file.stat()).isFile())
      throw new Error('REPLAY_REVIEW_FILE_INVALID');
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('REPLAY_REVIEW_FILE_TOO_LARGE');
    const keys = z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(1000)
      .parse(
        JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown,
      );
    if (new Set(keys).size !== keys.length)
      throw new Error('REPLAY_REVIEW_KEY_DUPLICATE');
    return keys.sort();
  } finally {
    await file.close();
  }
}

export function fullArchiveDays(startsAt: Date, cutoffAt: Date, zone: string) {
  let start = localJalaliDate(startsAt, zone);
  if (Date.parse(jalaliLocalMidnightUtc(start, zone)) < startsAt.getTime())
    start = localJalaliDate(
      new Date(Date.parse(jalaliLocalMidnightUtc(start, zone)) + 36 * 3600000),
      zone,
    );
  const lastDayStart = jalaliLocalMidnightUtc(
    localJalaliDate(cutoffAt, zone),
    zone,
  );
  const end = localJalaliDate(new Date(Date.parse(lastDayStart) - 1), zone);
  return start <= end ? { from: start, to: end } : { from: null, to: null };
}

/** Import privately staged files atomically. The immutable source key isolates
 * overlapping archive exports and ensures retries cannot append to a run. */
export async function importReplayArchive(db: DataSource, path: string) {
  if (!path.endsWith('.jsonl.gz')) throw new Error('REPLAY_ARCHIVE_FILENAME');
  const input = await ReplayInput.open(
    path,
    path.replace(/\.jsonl\.gz$/, '.manifest.json'),
    true,
  );
  try {
    const manifest = input.manifest;
    const sourceIdentity = manifest.identity === 'source-webhook';
    if (manifest.replay_event_children > MAX_ARCHIVE_EVENTS)
      throw new Error('REPLAY_ARCHIVE_TOO_MANY_EVENTS');
    const source = `replay-archive-${manifest.sha256_gzip}`;
    const cutoff = new Date(manifest.cutoff_utc);
    const start = new Date(cutoff.getTime() - manifest.window_days * DAY);
    const config = readConfig({
      ...process.env,
      PASARGUARD_SOURCE_INSTANCE_ID: source,
    });
    const inbox = new DurableInbox(
      db,
      new PayloadEncryption(config.APP_ENCRYPTION_KEY),
      config,
    );
    const counts = await input.preflight();
    if (counts.batches.size !== counts.groups)
      throw new Error('REPLAY_ARCHIVE_DUPLICATE_BATCH');
    const imported = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [source]);
      const [prior] = await tx.query<
        Array<{
          starts_at: Date;
          cutoff_at: Date;
          batch_count: number;
          expected_children: number;
          source_identity: boolean;
        }>
      >(
        'SELECT starts_at,cutoff_at,batch_count,expected_children,source_identity FROM fair_replay_archives WHERE source_instance_id=$1',
        [source],
      );
      if (prior) {
        if (
          prior.starts_at.getTime() !== start.getTime() ||
          prior.cutoff_at.getTime() !== cutoff.getTime() ||
          prior.batch_count !== counts.groups ||
          prior.expected_children !== counts.children ||
          prior.source_identity !== sourceIdentity
        )
          throw new Error('REPLAY_ARCHIVE_MANIFEST_CONFLICT');
        return false;
      }
      for await (const row of input.records()) {
        // The source exporter selects a half-open receipt window.
        if (row.receivedAt < start || row.receivedAt >= cutoff)
          throw new Error('REPLAY_ARCHIVE_OUTSIDE_WINDOW');
        await inbox.receiveInTransaction(tx, row.payload, row.receivedAt);
      }
      await tx.query(
        `INSERT INTO fair_replay_archives
         (source_instance_id,starts_at,cutoff_at,batch_count,expected_children,source_identity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source, start, cutoff, counts.groups, counts.children, sourceIdentity],
      );
      return true;
    });
    return {
      source,
      digest: manifest.sha256_gzip,
      imported,
      days: manifest.window_days,
    };
  } finally {
    await input.close();
  }
}

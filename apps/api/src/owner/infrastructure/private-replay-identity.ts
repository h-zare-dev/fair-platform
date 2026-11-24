import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { DataSource } from 'typeorm';
import { z } from 'zod';

const SOURCE = 'replay-30d';
const EXPECTED_EVENTS = 64135;
const MAX_MAP_BYTES = 12 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const EXPORTER_SHA256 = new Set([
  'ba8d01dc6a2d4c7f6b3fb8a179c2289304195bc5608df4df8373c41554dc9ecc',
  '103d7e202985fa9cf70290e100b6b16df9c14fb60e3c4840474211b2f79927df',
]);
const digest = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const username = z.string().max(255).nullable();
const record = z
  .object({
    role: z.enum(['account', 'billing_admin', 'actor_admin']),
    archive_id: id,
    real_id: id,
    names: z
      .array(
        z
          .object({ archive_username: username, real_username: username })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const manifestSchema = z
  .object({
    status: z.literal('VERIFIED_SOURCE_REPLAY_MATCH'),
    window_days: z.literal(30),
    source_script_sha256: hash,
    replay_plaintext_sha256: hash,
    replay_batch_multiset_verified: z.literal(true),
    read_only_sql_guard: z.literal(true),
    identity_map_sha256: hash,
    identity_map_filename: z.literal('PRIVATE-identity-map.jsonl.gz'),
    identity_summary: z
      .object({
        events_seen: z.literal(EXPECTED_EVENTS),
        distinct_identities: z.object({
          account: z.number().int().nonnegative(),
          billing_admin: z.number().int().nonnegative(),
          actor_admin: z.number().int().nonnegative(),
        }),
      })
      .passthrough(),
  })
  .passthrough();

export type PrivateIdentityAlias = {
  role: 'account' | 'billing_admin' | 'actor_admin';
  archivedId: string;
  archivedUsername: string;
  originalId: string;
  originalUsername: string | null;
};

/** This verifies exporter provenance and alias consistency, never current-admin equivalence. */
export function parsePrivateIdentityExport(
  manifestText: string,
  compressed: Buffer,
) {
  if (manifestText.length > 65536 || compressed.length > MAX_MAP_BYTES)
    throw new Error('PRIVATE_IDENTITY_INPUT_TOO_LARGE');
  const manifest = manifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (!EXPORTER_SHA256.has(manifest.source_script_sha256))
    throw new Error('PRIVATE_IDENTITY_SOURCE_NOT_APPROVED');
  if (digest(compressed) !== manifest.identity_map_sha256)
    throw new Error('PRIVATE_IDENTITY_DIGEST_MISMATCH');
  const lines = gunzipSync(compressed, { maxOutputLength: MAX_PLAINTEXT_BYTES })
    .toString('utf8')
    .trimEnd()
    .split('\n');
  if (lines.length > 40000)
    throw new Error('PRIVATE_IDENTITY_TOO_MANY_RECORDS');
  const aliases: PrivateIdentityAlias[] = [];
  const byArchive = new Map<string, string>();
  const byOriginal = new Map<string, string>();
  const byAlias = new Set<string>();
  const counts = { account: 0, billing_admin: 0, actor_admin: 0 };
  for (const line of lines) {
    if (line.length > 16000)
      throw new Error('PRIVATE_IDENTITY_RECORD_TOO_LARGE');
    const entry = record.parse(JSON.parse(line) as unknown);
    const key = `${entry.role}:${entry.archive_id}`;
    const reverse = `${entry.role}:${entry.real_id}`;
    if (byArchive.has(key) || byOriginal.has(reverse))
      throw new Error('PRIVATE_IDENTITY_ID_COLLISION');
    byArchive.set(key, entry.real_id);
    byOriginal.set(reverse, entry.archive_id);
    counts[entry.role]++;
    for (const name of entry.names) {
      const alias = name.archive_username ?? '';
      const aliasKey = JSON.stringify([entry.role, entry.archive_id, alias]);
      if (byAlias.has(aliasKey))
        throw new Error('PRIVATE_IDENTITY_ALIAS_COLLISION');
      byAlias.add(aliasKey);
      aliases.push({
        role: entry.role,
        archivedId: entry.archive_id,
        archivedUsername: alias,
        originalId: entry.real_id,
        originalUsername: name.real_username,
      });
    }
  }
  for (const role of ['account', 'billing_admin', 'actor_admin'] as const)
    if (counts[role] !== manifest.identity_summary.distinct_identities[role])
      throw new Error('PRIVATE_IDENTITY_MANIFEST_COUNT_MISMATCH');
  return {
    aliases,
    counts,
    manifestDigest: digest(manifestText),
    mapDigest: manifest.identity_map_sha256,
    replayDigest: manifest.replay_plaintext_sha256,
    sourceScriptDigest: manifest.source_script_sha256,
  };
}

/** Offline CLI import only. No HTTP endpoint, billing writes, logs or file retention. */
export async function importPrivateReplayIdentities(
  db: DataSource,
  manifestPath: string,
  mapPath: string,
) {
  if (
    !manifestPath.endsWith('/PRIVATE-identity-export-result.json') ||
    !mapPath.endsWith('/PRIVATE-identity-map.jsonl.gz') ||
    manifestPath.slice(0, manifestPath.lastIndexOf('/')) !==
      mapPath.slice(0, mapPath.lastIndexOf('/'))
  )
    throw new Error('PRIVATE_IDENTITY_PRIVATE_SIDECAR_PATH_REQUIRED');
  if (
    statSync(manifestPath).size > 65536 ||
    statSync(mapPath).size > MAX_MAP_BYTES
  )
    throw new Error('PRIVATE_IDENTITY_INPUT_TOO_LARGE');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const compressed = readFileSync(mapPath);
  const parsed = parsePrivateIdentityExport(manifestText, compressed);
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction('REPEATABLE READ');
    await runner.query(
      `SELECT pg_advisory_xact_lock(hashtext('fair-private-replay-identity'))`,
    );
    const [source] = (await runner.query(
      `SELECT COUNT(*)::text AS count FROM pasarguard_events WHERE source_instance_id=$1`,
      [SOURCE],
    )) as Array<{ count: string }>;
    if (Number(source?.count) !== EXPECTED_EVENTS)
      throw new Error('PRIVATE_IDENTITY_REPLAY_EVENT_COUNT_MISMATCH');
    const [already] = (await runner.query(
      `SELECT map_sha256,manifest_sha256,replay_plaintext_sha256
       FROM fair_replay_private_identity_imports WHERE source_instance_id=$1`,
      [SOURCE],
    )) as Array<{
      map_sha256: string;
      manifest_sha256: string;
      replay_plaintext_sha256: string;
    }>;
    if (already) {
      if (
        already.map_sha256 !== parsed.mapDigest ||
        already.manifest_sha256 !== parsed.manifestDigest ||
        already.replay_plaintext_sha256 !== parsed.replayDigest
      )
        throw new Error('PRIVATE_IDENTITY_EPOCH_ALREADY_IMPORTED');
      await runner.commitTransaction();
      return {
        status: 'ALREADY_IMPORTED',
        billingAdmins: parsed.counts.billing_admin,
      };
    }
    const mappedAliases = new Set(
      parsed.aliases.map((a) =>
        JSON.stringify([a.role, a.archivedId, a.archivedUsername]),
      ),
    );
    const archivedFields = {
      billing_admin: ['billing_admin_id', 'billing_admin_username'],
      account: ['external_user_id', 'username'],
      actor_admin: ['actor_admin_id', 'actor_admin_username'],
    } as const;
    const unmatched = { billing_admin: 0, account: 0, actor_admin: 0 };
    const matched = { billing_admin: 0, account: 0, actor_admin: 0 };
    for (const role of ['billing_admin', 'account', 'actor_admin'] as const) {
      const [idColumn, nameColumn] = archivedFields[role];
      const observed = (await runner.query(
        `SELECT DISTINCT ${idColumn}::text AS id,
         COALESCE(${nameColumn},'') AS alias FROM pasarguard_events
         WHERE source_instance_id=$1 AND ${idColumn} IS NOT NULL`,
        [SOURCE],
      )) as Array<{ id: string; alias: string }>;
      for (const pair of observed) {
        if (mappedAliases.has(JSON.stringify([role, pair.id, pair.alias])))
          matched[role]++;
        else unmatched[role]++;
      }
    }
    if (matched.billing_admin === 0)
      throw new Error('PRIVATE_IDENTITY_NO_ARCHIVE_MATCH');
    await runner.query(
      `INSERT INTO fair_replay_private_identity_imports
      (source_instance_id,manifest_sha256,map_sha256,replay_plaintext_sha256,source_script_sha256,
       event_count,mapped_admins,mapped_accounts,mapped_actor_admins,
       unmatched_admin_pairs,unmatched_account_pairs,unmatched_actor_pairs)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        SOURCE,
        parsed.manifestDigest,
        parsed.mapDigest,
        parsed.replayDigest,
        parsed.sourceScriptDigest,
        EXPECTED_EVENTS,
        parsed.counts.billing_admin,
        parsed.counts.account,
        parsed.counts.actor_admin,
        unmatched.billing_admin,
        unmatched.account,
        unmatched.actor_admin,
      ],
    );
    for (let offset = 0; offset < parsed.aliases.length; offset += 500) {
      const chunk = parsed.aliases.slice(offset, offset + 500);
      await runner.query(
        `INSERT INTO fair_replay_private_identity_aliases
        (source_instance_id,role,archived_id,archived_username,original_id,original_username)
        SELECT $1,x.role,x."archivedId"::bigint,x."archivedUsername",x."originalId"::bigint,x."originalUsername"
        FROM jsonb_to_recordset($2::jsonb) AS x(role text,"archivedId" text,
          "archivedUsername" text,"originalId" text,"originalUsername" text)`,
        [SOURCE, JSON.stringify(chunk)],
      );
    }
    await runner.commitTransaction();
    return {
      status: 'IMPORTED',
      billingAdmins: parsed.counts.billing_admin,
      accounts: parsed.counts.account,
      actorAdmins: parsed.counts.actor_admin,
      unmatchedArchiveAdminPairs: unmatched.billing_admin,
      unmatchedArchiveAccountPairs: unmatched.account,
      unmatchedArchiveActorPairs: unmatched.actor_admin,
    };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

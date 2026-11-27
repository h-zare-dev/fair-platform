import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importPrivateReplayIdentities,
  parsePrivateIdentityExport,
} from '../../apps/api/src/owner/infrastructure/private-replay-identity.js';

const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const entries = [
  {
    role: 'billing_admin',
    archive_id: '10017',
    real_id: '17',
    names: [
      { archive_username: 'anon-a1b2c3d4', real_username: 'reseller-ali' },
    ],
  },
  {
    role: 'account',
    archive_id: '10900',
    real_id: '900',
    names: [
      { archive_username: 'anon-f1b2c3d4', real_username: 'account-ali' },
    ],
  },
  {
    role: 'actor_admin',
    archive_id: '10019',
    real_id: '19',
    names: [{ archive_username: null, real_username: null }],
  },
];

function fixture(
  records: unknown[] = entries,
  overrides: Record<string, unknown> = {},
) {
  const compressed = gzipSync(
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const manifest = {
    status: 'VERIFIED_SOURCE_REPLAY_MATCH',
    window_days: 30,
    source_script_sha256:
      '103d7e202985fa9cf70290e100b6b16df9c14fb60e3c4840474211b2f79927df',
    replay_plaintext_sha256: 'a'.repeat(64),
    replay_batch_multiset_verified: true,
    read_only_sql_guard: true,
    identity_map_sha256: sha(compressed),
    identity_map_filename: 'PRIVATE-identity-map.jsonl.gz',
    identity_summary: {
      events_seen: 64135,
      distinct_identities: { billing_admin: 1, account: 1, actor_admin: 1 },
    },
    ...overrides,
  };
  return { compressed, manifest: JSON.stringify(manifest) };
}

describe('private 30-day historical identity export', () => {
  it('accepts only source-verified aliases and preserves role and real ID separately', () => {
    const { compressed, manifest } = fixture();
    const value = parsePrivateIdentityExport(manifest, compressed);
    expect(value.counts).toEqual({
      account: 1,
      billing_admin: 1,
      actor_admin: 1,
    });
    expect(value.aliases).toContainEqual({
      role: 'billing_admin',
      archivedId: '10017',
      archivedUsername: 'anon-a1b2c3d4',
      originalId: '17',
      originalUsername: 'reseller-ali',
    });
    expect(
      value.aliases.find((v) => v.role === 'actor_admin')?.originalUsername,
    ).toBeNull();
  });

  it('rejects a modified map, different exporter, or unproven replay', () => {
    const { compressed, manifest } = fixture();
    expect(() =>
      parsePrivateIdentityExport(manifest, Buffer.from('not a sidecar')),
    ).toThrow('PRIVATE_IDENTITY_DIGEST_MISMATCH');
    expect(() =>
      parsePrivateIdentityExport(
        fixture(entries, { source_script_sha256: 'f'.repeat(64) }).manifest,
        compressed,
      ),
    ).toThrow('PRIVATE_IDENTITY_SOURCE_NOT_APPROVED');
    expect(() =>
      parsePrivateIdentityExport(
        fixture(entries, { replay_batch_multiset_verified: false }).manifest,
        compressed,
      ),
    ).toThrow();
  });

  it('rejects duplicate aliased IDs, repeated original IDs and conflicting aliases', () => {
    const aliasCollision = {
      ...entries[0]!,
      names: [
        { archive_username: 'anon-a1b2c3d4', real_username: 'ali' },
        { archive_username: 'anon-a1b2c3d4', real_username: 'other' },
      ],
    };
    let sample = fixture([aliasCollision, entries[1], entries[2]]);
    expect(() =>
      parsePrivateIdentityExport(sample.manifest, sample.compressed),
    ).toThrow('PRIVATE_IDENTITY_ALIAS_COLLISION');
    sample = fixture(
      [
        entries[0],
        { ...entries[0], archive_id: '10018' },
        entries[1],
        entries[2],
      ],
      {
        identity_summary: {
          events_seen: 64135,
          distinct_identities: { billing_admin: 2, account: 1, actor_admin: 1 },
        },
      },
    );
    expect(() =>
      parsePrivateIdentityExport(sample.manifest, sample.compressed),
    ).toThrow('PRIVATE_IDENTITY_ID_COLLISION');
  });

  it('requires exact manifest event and identity counts and bounds decompression', () => {
    const { compressed } = fixture();
    expect(() =>
      parsePrivateIdentityExport(
        fixture(entries, {
          identity_summary: {
            events_seen: 1,
            distinct_identities: {
              billing_admin: 1,
              account: 1,
              actor_admin: 1,
            },
          },
        }).manifest,
        compressed,
      ),
    ).toThrow();
    expect(() =>
      parsePrivateIdentityExport(
        fixture(entries, {
          identity_summary: {
            events_seen: 64135,
            distinct_identities: {
              billing_admin: 2,
              account: 1,
              actor_admin: 1,
            },
          },
        }).manifest,
        compressed,
      ),
    ).toThrow('PRIVATE_IDENTITY_MANIFEST_COUNT_MISMATCH');
    const large = Buffer.from('x'.repeat(33 * 1024 * 1024));
    const bomb = gzipSync(large);
    expect(() =>
      parsePrivateIdentityExport(
        fixture(entries, { identity_map_sha256: sha(bomb) }).manifest,
        bomb,
      ),
    ).toThrow();
  });

  it('imports only source-scoped display aliases in one transaction, is idempotent and refuses archive drift', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'private-replay-identity-test-'));
    try {
      const { compressed, manifest } = fixture();
      const manifestPath = join(temp, 'PRIVATE-identity-export-result.json');
      const mapPath = join(temp, 'PRIVATE-identity-map.jsonl.gz');
      writeFileSync(manifestPath, manifest);
      writeFileSync(mapPath, compressed);
      const parsed = parsePrivateIdentityExport(manifest, compressed);
      let eventCount = '64135';
      let imported = false;
      let committed = 0;
      let rolledBack = 0;
      const sql: string[] = [];
      const db = {
        createQueryRunner: () => ({
          isTransactionActive: true,
          connect: () => Promise.resolve(),
          startTransaction: (level: string) => {
            expect(level).toBe('REPEATABLE READ');
            return Promise.resolve();
          },
          commitTransaction: () => {
            committed++;
            return Promise.resolve();
          },
          rollbackTransaction: () => {
            rolledBack++;
            return Promise.resolve();
          },
          release: () => Promise.resolve(),
          query: (statement: string) => {
            sql.push(statement);
            if (
              statement.includes(
                'SELECT COUNT(*)::text AS count FROM pasarguard_events',
              )
            )
              return Promise.resolve([{ count: eventCount }]);
            if (statement.includes('SELECT map_sha256,manifest_sha256'))
              return Promise.resolve(
                imported
                  ? [
                      {
                        map_sha256: parsed.mapDigest,
                        manifest_sha256: parsed.manifestDigest,
                        replay_plaintext_sha256: parsed.replayDigest,
                      },
                    ]
                  : [],
              );
            if (statement.includes('SELECT DISTINCT billing_admin_id::text'))
              return Promise.resolve([{ id: '10017', alias: 'anon-a1b2c3d4' }]);
            if (statement.includes('SELECT DISTINCT external_user_id::text'))
              return Promise.resolve([{ id: '10900', alias: 'anon-f1b2c3d4' }]);
            if (statement.includes('SELECT DISTINCT actor_admin_id::text'))
              return Promise.resolve([{ id: '10019', alias: '' }]);
            if (
              statement.includes(
                'INSERT INTO fair_replay_private_identity_imports',
              )
            )
              imported = true;
            return Promise.resolve([]);
          },
        }),
      } as unknown as Parameters<typeof importPrivateReplayIdentities>[0];
      expect(
        await importPrivateReplayIdentities(db, manifestPath, mapPath),
      ).toMatchObject({
        status: 'IMPORTED',
        billingAdmins: 1,
        unmatchedArchiveAdminPairs: 0,
      });
      const writes = sql.filter((s) => s.includes('INSERT INTO'));
      expect(writes).toHaveLength(2);
      expect(
        writes.every((s) => s.includes('fair_replay_private_identity_')),
      ).toBe(true);
      expect(committed).toBe(1);
      expect(
        await importPrivateReplayIdentities(db, manifestPath, mapPath),
      ).toMatchObject({ status: 'ALREADY_IMPORTED' });
      expect(sql.filter((s) => s.includes('INSERT INTO'))).toHaveLength(2);
      eventCount = '64134';
      await expect(
        importPrivateReplayIdentities(db, manifestPath, mapPath),
      ).rejects.toThrow('PRIVATE_IDENTITY_REPLAY_EVENT_COUNT_MISMATCH');
      expect(rolledBack).toBe(1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

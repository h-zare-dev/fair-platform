import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresOpeningBaseline } from '../../apps/api/dist/owner/infrastructure/opening-baseline.js';
import type {
  OpeningBaselineDirectory,
  OpeningUser,
} from '../../apps/api/dist/owner/infrastructure/opening-baseline-directory.js';

const sample = (id: number, version = 1): OpeningUser => ({
  externalUserId: String(id),
  billingAdminId: '17',
  status: 'active',
  dataLimitBytes: String(version * 1073741824),
  usedTrafficBytes: '0',
  expiresAt: null,
  onHoldDurationSeconds: null,
  resetStrategy: 'no_reset',
  sourceCreatedAt: '2026-11-01T00:00:00Z',
  sourceEditedAt: null,
  fingerprint: `${version.toString(16).padStart(2, '0')}${id.toString(16).padStart(62, '0')}`,
});

let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
}, 120000);
afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});

describe('FP-006 opening baseline transaction and recovery', () => {
  it('resumes a multi-page 53-account scan after the importer process is replaced', async () => {
    const all = Array.from({ length: 53 }, (_, i) => String(i + 100));
    const directory: OpeningBaselineDirectory = {
      listIds(offset, limit) {
        return Promise.resolve({
          ids: all.slice(offset, offset + limit),
          total: 53,
        });
      },
      details(ids) {
        return Promise.resolve(ids.map((id) => sample(Number(id))));
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    expect((await importer.summary()).cutoverLocked).toBe(false);
    await importer.start();
    expect(await importer.runNext()).toBe(true);
    expect((await importer.summary()).run).toMatchObject({
      status: 'SCANNING',
      sourceTotal: 53,
      firstPassUsers: 50,
      offset: 50,
    });
    const recovered = new PostgresOpeningBaseline(db, directory);
    await recovered.runNext();
    await recovered.runNext();
    await recovered.runNext();
    expect((await recovered.summary()).run).toMatchObject({
      status: 'COMPLETE',
      sourceTotal: 53,
      verifiedTotal: 53,
      firstPassUsers: 53,
      stable: 53,
      nonMaterialChanged: 0,
      changed: 0,
      missing: 0,
      added: 0,
    });
  });

  it('commits zero billing, detects changed/deleted/created accounts and prevents duplicate runs', async () => {
    let reads = 0;
    let detailReads = 0;
    const directory: OpeningBaselineDirectory = {
      listIds() {
        reads++;
        return Promise.resolve({
          ids: reads === 1 ? ['1', '2', '4'] : ['1', '2', '3'],
          total: reads === 1 ? 3 : 4,
        });
      },
      details(ids) {
        detailReads++;
        return Promise.resolve(
          ids
            .filter((id) => detailReads === 1 || id !== '4')
            .map((id) =>
              sample(Number(id), detailReads > 1 && id === '2' ? 2 : 1),
            ),
        );
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    const run = await importer.start();
    expect(run.status).toBe('PENDING');
    expect((await importer.summary()).run).toMatchObject({
      firstPassUsers: 0,
      unknownAdmin: 0,
      unknownVolume: 0,
      unknownExactDuration: 0,
    });
    await expect(importer.start()).rejects.toThrow(
      'OPENING_BASELINE_ALREADY_RUNNING',
    );
    expect(await importer.runNext()).toBe(true);
    expect((await importer.summary()).run?.status).toBe('VERIFYING');
    expect(await importer.runNext()).toBe(true);
    const result = await importer.summary();
    expect(result).toMatchObject({
      postingScope: 'NONE',
      financialCutoverReady: false,
      run: {
        status: 'COMPLETE',
        firstPassUsers: 3,
        stable: 1,
        changed: 1,
        added: 0,
        missing: 1,
        sourceTotal: 3,
        verifiedTotal: 4,
        unknownExactDuration: 3,
      },
    });
    // Owner's baseline database has no accounting ledger migration at all.
    // Import must not create a ledger or introduce any posting side effect.
    expect(
      await db.query(
        "SELECT to_regclass('accounting_transactions')::text AS name",
      ),
    ).toEqual([{ name: null }]);
    await expect(
      db.query(`DELETE FROM fair_opening_baseline_users WHERE run_id=$1`, [
        run.id,
      ]),
    ).rejects.toThrow('OPENING_BASELINE_IMMUTABLE');
    expect(await importer.runNext()).toBe(false);
  });

  it('tolerates live count changes during both scan pages and roster verification', async () => {
    const first = Array.from({ length: 50 }, (_, i) => String(i + 100));
    const calls: { offset: number; limit: number }[] = [];
    let lookups = 0;
    const directory: OpeningBaselineDirectory = {
      listIds(offset, limit) {
        calls.push({ offset, limit });
        if (limit === 1) return Promise.resolve({ ids: ['100'], total: 52 });
        if (offset === 0) return Promise.resolve({ ids: first, total: 51 });
        return Promise.resolve({ ids: ['151', '152'], total: 52 });
      },
      details(ids) {
        lookups++;
        return Promise.resolve(
          ids
            .filter((id) => id !== '101' || lookups === 1)
            .map((id) => ({
              ...sample(Number(id)),
              // Active usage is non-material; the verified fingerprint still differs.
              usedTrafficBytes: lookups > 2 ? '100' : '0',
              fingerprint:
                lookups > 2
                  ? `ab${id.padStart(62, '0')}`
                  : sample(Number(id)).fingerprint,
            })),
        );
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    await importer.start();
    for (let i = 0; i < 4; i++) expect(await importer.runNext()).toBe(true);
    expect((await importer.summary()).run).toMatchObject({
      status: 'COMPLETE',
      sourceTotal: 51,
      verifiedTotal: 52,
      firstPassUsers: 52,
      stable: 51,
      nonMaterialChanged: 51,
      missing: 1,
      added: 0,
    });
    expect(
      calls.filter(({ limit }) => limit === 50).map(({ offset }) => offset),
    ).toEqual([0, 50]);
    // Verification is by stored IDs; it never enumerates live offsets again.
    expect(
      calls.filter(({ limit, offset }) => limit === 1 && offset === 0),
    ).toHaveLength(2);
  });

  it('completes safely when the source shrinks below the next scan offset', async () => {
    const first = Array.from({ length: 50 }, (_, i) => String(i + 500));
    let deleted = false;
    const directory: OpeningBaselineDirectory = {
      listIds(offset, limit) {
        if (limit === 1) return Promise.resolve({ ids: ['500'], total: 50 });
        if (offset === 0) return Promise.resolve({ ids: first, total: 51 });
        deleted = true;
        return Promise.resolve({ ids: [], total: 50 });
      },
      details(ids) {
        return Promise.resolve(ids.map((id) => sample(Number(id))));
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    await importer.start();
    for (let i = 0; i < 3; i++) await importer.runNext();
    expect(deleted).toBe(true);
    expect((await importer.summary()).run).toMatchObject({
      status: 'COMPLETE',
      sourceTotal: 51,
      verifiedTotal: 50,
      firstPassUsers: 50,
      stable: 50,
      missing: 0,
    });
  });

  it('recovers the ID boundary when a deletion shifts the live source offset', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 100));
    let deleted = false;
    const directory: OpeningBaselineDirectory = {
      listIds(offset, limit) {
        const live = deleted ? ids.slice(1) : ids;
        return Promise.resolve({
          ids: live.slice(offset, offset + limit),
          total: live.length,
        });
      },
      details(requested) {
        return Promise.resolve(
          requested
            .filter((id) => !deleted || id !== '100')
            .map((id) => sample(Number(id))),
        );
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    await importer.start();
    await importer.runNext();
    deleted = true;
    for (let i = 0; i < 3; i++) await importer.runNext();
    expect((await importer.summary()).run).toMatchObject({
      status: 'COMPLETE',
      sourceTotal: 51,
      verifiedTotal: 50,
      firstPassUsers: 51,
      stable: 50,
      missing: 1,
      unverified: 0,
    });
  });

  it('fails closed without committing partial pages when source ID order regresses', async () => {
    let reads = 0;
    const directory: OpeningBaselineDirectory = {
      listIds(offset) {
        reads++;
        if (!offset)
          return Promise.resolve({
            ids: Array.from({ length: 50 }, (_, i) => String(i + 10)),
            total: 51,
          });
        return Promise.resolve({ ids: ['59'], total: 52 });
      },
      details(ids) {
        return Promise.resolve(ids.map((id) => sample(Number(id))));
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    const run = await importer.start();
    await importer.runNext();
    await importer.runNext();
    expect((await importer.summary()).run).toMatchObject({
      id: run.id,
      status: 'FAILED',
      failureCode: 'OPENING_BASELINE_ORDER_CHANGED',
      firstPassUsers: 50,
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    await expect(
      db.query(
        'UPDATE fair_opening_baseline_users SET verification_status=$1 WHERE run_id=$2',
        ['STABLE', run.id],
      ),
    ).rejects.toThrow('OPENING_BASELINE_IMMUTABLE');
  });

  it('replaces the selected snapshot without erasing immutable historical runs or duplicating retries', async () => {
    const directory: OpeningBaselineDirectory = {
      listIds() {
        return Promise.resolve({ ids: ['9901'], total: 1 });
      },
      details(ids) {
        return Promise.resolve(ids.map((id) => sample(Number(id))));
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    const before = await importer.summary();
    const key = '5c18f4cd-3318-43c7-a4b0-9647d22a72ed';
    const first = await importer.start(key);
    expect(first.generation).toBe(before.generation + 1);
    expect(await importer.start(key)).toEqual(first);
    await expect(
      importer.start('7798af8e-8bd9-41ab-a2fe-f278ac1c506f'),
    ).rejects.toThrow('OPENING_BASELINE_ALREADY_RUNNING');
    for (let i = 0; i < 3; i++) await importer.runNext();
    expect((await importer.summary()).run).toMatchObject({
      id: first.id,
      status: 'COMPLETE',
      firstPassUsers: 1,
    });
    const [retained] = await db.query<{ count: string }[]>(
      'SELECT COUNT(*)::text AS count FROM fair_opening_baseline_users WHERE run_id=$1',
      [before.run!.id],
    );
    expect(Number(retained!.count)).toBeGreaterThan(0);
    const next = await importer.start('5855d99a-bcb6-4d50-bf87-3e0d419b598b');
    expect(next.generation).toBe(first.generation + 1);
    expect((await importer.summary()).run).toMatchObject({
      id: next.id,
      status: 'PENDING',
      firstPassUsers: 0,
    });
    for (let i = 0; i < 3; i++) await importer.runNext();
    await db.query(`UPDATE fair_opening_baseline_control
      SET financial_cutover_started_at=clock_timestamp()
      WHERE source_instance_id='primary'`);
    await expect(importer.start()).rejects.toThrow(
      'OPENING_BASELINE_CUTOVER_LOCKED',
    );
    await db.query(`UPDATE fair_opening_baseline_control
      SET financial_cutover_started_at=NULL WHERE source_instance_id='primary'`);
    await expect(
      db.query('DELETE FROM fair_opening_baseline_reseed_audit'),
    ).rejects.toThrow('OPENING_BASELINE_AUDIT_IMMUTABLE');
  });
});

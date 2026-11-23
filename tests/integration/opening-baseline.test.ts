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
      changed: 0,
      missing: 0,
      added: 0,
    });
  });

  it('commits zero billing, detects changed/deleted/created accounts and prevents duplicate runs', async () => {
    let pass = 0;
    const directory: OpeningBaselineDirectory = {
      listIds() {
        pass++;
        return Promise.resolve({
          ids: pass === 1 ? ['1', '2', '4'] : ['1', '2', '3'],
          total: 3,
        });
      },
      details(ids) {
        return Promise.resolve(
          ids.map((id) => sample(Number(id), pass === 2 && id === '2' ? 2 : 1)),
        );
      },
    };
    const importer = new PostgresOpeningBaseline(db, directory);
    const run = await importer.start();
    expect(run.status).toBe('PENDING');
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
        added: 1,
        missing: 1,
        unknownExactDuration: 4,
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

  it('fails closed without committing partial pages when the API total changes', async () => {
    let reads = 0;
    const directory: OpeningBaselineDirectory = {
      listIds(offset) {
        reads++;
        if (!offset)
          return Promise.resolve({
            ids: Array.from({ length: 50 }, (_, i) => String(i + 10)),
            total: 51,
          });
        return Promise.resolve({ ids: ['60'], total: 52 });
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
      failureCode: 'OPENING_BASELINE_TOTAL_CHANGED',
      firstPassUsers: 50,
    });
    expect(reads).toBe(2);
    await expect(
      db.query(
        'UPDATE fair_opening_baseline_users SET verification_status=$1 WHERE run_id=$2',
        ['STABLE', run.id],
      ),
    ).rejects.toThrow('OPENING_BASELINE_IMMUTABLE');
  });
});

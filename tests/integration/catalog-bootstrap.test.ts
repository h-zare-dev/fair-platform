import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresCatalogStore } from '../../apps/api/dist/owner/infrastructure/catalog-store.js';
import { STATIC_CATALOG_SHAPES } from '../../apps/api/dist/owner/application/static-catalog-bootstrap.js';
import { evaluateReplayStaticCatalog } from '../../apps/api/dist/owner/infrastructure/replay-preview.js';

const prices = STATIC_CATALOG_SHAPES.map((row, index) => ({
  name: row.name,
  amountToman: String(200000 + index * 1000),
}));
const adminIds = Array.from({ length: 153 }, (_, i) => String(i + 1));

describe('atomic one-time fixed catalog setup on real PostgreSQL 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof createOwnerDataSource>;
  let store: PostgresCatalogStore;
  beforeAll(async () => {
    container = await startPostgres();
    db = createOwnerDataSource(container.getConnectionUri());
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    store = new PostgresCatalogStore(db, 'Asia/Tehran');
  }, 120000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (container) await container.stop();
  });

  it('rolls back every catalog/audit write on a mid-transaction failure, then creates exact 25/153 in one commit', async () => {
    await expect(
      store.bootstrapStaticCatalog({ prices: prices.slice(0, 24), adminIds }),
    ).rejects.toThrow();
    await expect(
      store.bootstrapStaticCatalog({
        prices,
        adminIds: adminIds.slice(0, 152),
      }),
    ).rejects.toThrow();
    await db.query(`CREATE FUNCTION synthetic_fail_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SYNTHETIC_BOOTSTRAP_FAILURE'; END $$`);
    await db.query(`CREATE TRIGGER synthetic_fail_bootstrap_trigger BEFORE INSERT ON fair_tariff_assignments
      FOR EACH ROW EXECUTE FUNCTION synthetic_fail_bootstrap()`);
    await expect(
      store.bootstrapStaticCatalog({ prices, adminIds }),
    ).rejects.toThrow('SYNTHETIC_BOOTSTRAP_FAILURE');
    for (const table of [
      'fair_admin_groups',
      'fair_atomic_packages',
      'fair_admin_group_memberships',
      'fair_admin_group_membership_audit',
      'fair_tariff_assignments',
    ]) {
      const [row] = await db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE source_instance_id='primary'`,
      );
      expect(row!.count).toBe('0');
    }
    await db.query(
      'DROP TRIGGER synthetic_fail_bootstrap_trigger ON fair_tariff_assignments',
    );
    await db.query('DROP FUNCTION synthetic_fail_bootstrap()');
    const completed = await store.bootstrapStaticCatalog({ prices, adminIds });
    expect(completed).toMatchObject({
      packageCount: 25,
      groupCount: 1,
      memberCount: 153,
      assignedPackageCount: 25,
    });
    const config = await store.list('primary');
    expect(config.groups).toHaveLength(1);
    expect(config.packages).toHaveLength(25);
    expect(config.memberships).toHaveLength(153);
    expect(config.assignments).toHaveLength(25);
    const [audit] = await db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM fair_admin_group_membership_audit WHERE source_instance_id='primary'`,
    );
    expect(audit!.count).toBe('153');
    expect(config.packages.every((v) => v.everAssigned)).toBe(true);
    const result = evaluateReplayStaticCatalog(
      config.packages,
      config.memberships,
      config.assignments,
      [
        {
          billingAdminId: '1',
          dataLimitBytes: STATIC_CATALOG_SHAPES[0].packageBytes,
          onHoldDurationSeconds: '2592000',
          eventStatus: 'READY_FOR_ACCOUNTING',
          isCorrection: false,
          eventCount: 3,
        },
      ],
      [{ action: 'user_created', eventCount: 3 }],
      'Asia/Tehran',
      { batchCount: '15914', childCount: '64135', unfinishedBatches: '0' },
    );
    expect(result.configurationReady).toBe(true);
    expect(result.createOnlySubtotalToman).toBe('600000');
    await expect(
      store.bootstrapStaticCatalog({ prices, adminIds }),
    ).rejects.toThrow('CATALOG_BOOTSTRAP_NOT_EMPTY');
    expect((await store.list('primary')).packages).toHaveLength(25);
  }, 120000);
});

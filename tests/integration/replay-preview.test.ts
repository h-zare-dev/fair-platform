import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresShadowReader } from '../../apps/api/dist/owner/infrastructure/shadow-reader.js';

const GIB = 1073741824n;
const packages = Array.from({ length: 25 }, (_, i) => ({
  id: String(i + 1),
  packageBytes: (BigInt(50 + i) * GIB).toString(),
  durationDays: 30,
  amountToman: String(250000 + i * 1000),
}));
const memberships = Array.from({ length: 153 }, (_, i) => ({
  billingAdminId: String(i + 1),
  groupId: '77',
}));
const assignments = packages.map((pkg, i) => ({
  id: String(i + 1),
  targetKind: 'GROUP' as const,
  groupId: '77',
  billingAdminId: null,
  packageId: pkg.id,
  rateTomanPerGiB: null,
}));

describe('real PostgreSQL 17 replay grouping', () => {
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

  it('aggregates exact Create shapes, holds same-local-day cross-admin corrections, never returns usernames', async () => {
    const [batch] = await db.query<{ id: string }[]>(
      `INSERT INTO pasarguard_webhook_batches
        (source_instance_id,received_at,payload_hash,event_count,processing_status)
       VALUES('replay-30d',now(),$1,5,'NORMALIZED') RETURNING id::text`,
      ['a'.repeat(64)],
    );
    const events = [
      ['user_created', 'synthetic-alice', '1', '2026-10-10T01:00:00Z'],
      ['user_deleted', 'synthetic-alice', '2', '2026-10-10T02:00:00Z'],
      ['user_created', 'synthetic-bob', '1', '2026-10-10T03:00:00Z'],
      ['user_created', 'synthetic-bob', '1', '2026-10-11T03:00:00Z'],
      ['user_updated', 'synthetic-carol', '1', '2026-10-11T04:00:00Z'],
    ];
    for (const [index, row] of events.entries()) {
      const [action, username, admin, at] = row;
      await db.query(
        `INSERT INTO pasarguard_events (
          batch_id,batch_index,source_instance_id,semantic_fingerprint,
          action,external_user_id,username,user_status,data_limit_bytes,
          used_traffic_bytes,lifetime_used_bytes,billing_admin_id,
          billing_admin_username,source_enqueued_at,event_status,
          first_seen_at,last_seen_at,on_hold_expire_duration_seconds
        ) VALUES ($1,$2,'replay-30d',$3,$4,$5,$6,'active',$7,
          0,0,$8,'synthetic-admin',$9,'READY_FOR_ACCOUNTING',now(),now(),2592000)`,
        [
          batch!.id,
          index,
          String(index + 1).padStart(64, '0'),
          action,
          String(index + 1),
          username,
          packages[0]!.packageBytes,
          admin,
          at,
        ],
      );
    }
    const query = (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM fair_atomic_packages'))
        return Promise.resolve(packages);
      if (sql.includes('FROM fair_admin_group_memberships'))
        return Promise.resolve(memberships);
      if (sql.includes('FROM fair_tariff_assignments'))
        return Promise.resolve(assignments);
      if (sql.includes('FROM pasarguard_webhook_batches'))
        return Promise.resolve([
          { batchCount: '15914', childCount: '64135', unfinishedBatches: '0' },
        ]);
      return db.query(sql, params);
    };
    const reader = new PostgresShadowReader({ query } as never, 'Asia/Tehran');
    const result = await reader.replayPreview();
    expect(result).toMatchObject({
      normalizedEventCount: 5,
      createEventCount: 3,
      pricedCreateCount: 2,
      heldCreateCount: 1,
      unclassifiedEventCount: 2,
      createOnlySubtotalToman: '500000',
    });
    expect(result.heldReasons).toContainEqual({
      code: 'AMBIGUOUS_CORRECTION',
      count: 1,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-alice');
    expect(JSON.stringify(result)).not.toContain('synthetic-bob');
  }, 120000);
});

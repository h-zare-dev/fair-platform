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

  it('recognizes only tightly bounded active half-GiB two-day dates in PostgreSQL without weakening the strict quote', async () => {
    // The disposable test DB has no live data; isolate this fixture from the earlier test.
    await db.query(
      "DELETE FROM pasarguard_events WHERE source_instance_id='replay-30d'",
    );
    const [batch] = await db.query<{ id: string }[]>(
      `INSERT INTO pasarguard_webhook_batches
        (source_instance_id,received_at,payload_hash,event_count,processing_status)
       VALUES('replay-30d',now(),$1,6,'NORMALIZED') RETURNING id::text`,
      ['b'.repeat(64)],
    );
    const half = (GIB / 2n).toString();
    const created = '2026-10-12T08:00:00Z';
    const validExpire = '2026-10-14T07:59:59.600Z';
    const cases = [
      {
        status: 'active',
        size: half,
        enqueued: '2026-10-12T08:00:00.200Z',
        expire: validExpire,
      },
      {
        status: 'active',
        size: half,
        enqueued: '2026-10-12T08:00:02Z',
        expire: validExpire,
      },
      {
        status: 'active',
        size: half,
        enqueued: '2026-10-12T08:00:00.200Z',
        expire: '2026-10-15T08:00:00Z',
      },
      {
        status: 'on_hold',
        size: half,
        enqueued: '2026-10-12T08:00:00.200Z',
        expire: validExpire,
      },
      {
        status: 'active',
        size: GIB.toString(),
        enqueued: '2026-10-12T08:00:00.200Z',
        expire: validExpire,
      },
      {
        status: 'active',
        size: half,
        enqueued: '2026-10-12T08:00:00.200Z',
        expire: null,
      },
    ];
    for (const [index, row] of cases.entries()) {
      await db.query(
        `INSERT INTO pasarguard_events (
          batch_id,batch_index,source_instance_id,semantic_fingerprint,
          action,external_user_id,username,user_status,data_limit_bytes,
          used_traffic_bytes,lifetime_used_bytes,billing_admin_id,
          billing_admin_username,source_enqueued_at,source_user_created_at,
          source_user_expire_at,event_status,first_seen_at,last_seen_at
        ) VALUES ($1,$2,'replay-30d',$3,'user_created',$4,$5,$6,$7,
          0,0,1,'synthetic-admin',$8,$9,$10,'READY_FOR_ACCOUNTING',now(),now())`,
        [
          batch!.id,
          index,
          String(index + 10).padStart(64, '0'),
          String(index + 10),
          `synthetic-active-${index}`,
          row.status,
          row.size,
          row.enqueued,
          created,
          row.expire,
        ],
      );
    }
    const trialCatalog = packages.map((pkg, i) =>
      i === 24
        ? { ...pkg, packageBytes: half, durationDays: 2, amountToman: '1000' }
        : pkg,
    );
    const query = (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM fair_atomic_packages'))
        return Promise.resolve(trialCatalog);
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
    const result = await new PostgresShadowReader(
      { query } as never,
      'Asia/Tehran',
    ).replayPreview();
    expect(result).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
      pricedCreateCount: 0,
      createOnlySubtotalToman: '0',
      ownerAttestedWhatIf: {
        activeTwoDayInferredPricedCreateCount: 1,
        pricedCreateCount: 1,
        heldCreateCount: 5,
        createOnlySubtotalToman: '1000',
      },
    });
    expect(result.ownerAttestedWhatIf.heldReasons).toContainEqual({
      code: 'MISSING_DURATION',
      count: 5,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-active-');
  }, 120000);

  it('correlates only evidenced Update+Reset renewals and prices independent actions exactly once in PostgreSQL', async () => {
    await db.query(
      "DELETE FROM pasarguard_events WHERE source_instance_id='replay-30d'",
    );
    const [batch] = await db.query<{ id: string }[]>(
      `INSERT INTO pasarguard_webhook_batches
        (source_instance_id,received_at,payload_hash,event_count,processing_status)
       VALUES('replay-30d',now(),$1,32,'NORMALIZED') RETURNING id::text`,
      ['c'.repeat(64)],
    );
    const gb = (value: number) => (BigInt(value) * GIB).toString();
    const events: {
      user: number;
      admin: number;
      action: string;
      bytes: string;
      at: string;
      duration: string | null;
    }[] = [];
    const add = (
      user: number,
      action: string,
      bytes: number,
      at: string,
      admin = 1,
      duration: string | null = '2592000',
    ) => events.push({ user, admin, action, bytes: gb(bytes), at, duration });

    add(1, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(1, 'data_usage_reset', 50, '2026-10-10T10:00:00Z');
    add(1, 'user_updated', 100, '2026-10-10T10:00:01Z');
    add(2, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(2, 'user_updated', 50, '2026-10-10T10:00:00Z');
    // The Reset does not carry a duration; the one unchanged Update does.
    add(2, 'data_usage_reset', 50, '2026-10-10T10:00:01Z', 1, null);
    add(3, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(3, 'user_updated', 100, '2026-10-10T10:00:00Z');
    add(4, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(4, 'user_updated', 25, '2026-10-10T10:00:00Z');
    add(5, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(5, 'data_usage_reset', 50, '2026-10-10T10:00:00Z');
    add(6, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(6, 'data_usage_reset', 50, '2026-10-10T10:00:00Z');
    add(6, 'user_updated', 100, '2026-10-10T10:00:01Z');
    add(6, 'user_updated', 50, '2026-10-10T10:00:02Z');
    add(7, 'data_usage_reset', 50, '2026-10-10T10:00:00Z');
    add(7, 'user_updated', 100, '2026-10-10T10:00:01Z');
    add(8, 'user_created', 50, '2026-10-10T09:00:00Z', 2);
    add(8, 'user_created', 50, '2026-10-10T09:00:00Z', 3);
    add(8, 'user_updated', 100, '2026-10-10T10:00:01Z', 2);
    add(8, 'data_usage_reset', 50, '2026-10-10T10:00:00Z', 3);
    // Update-before-Reset must yield one renewal at the latter final snapshot.
    add(9, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(9, 'user_updated', 100, '2026-10-10T10:00:00Z');
    add(9, 'data_usage_reset', 100, '2026-10-10T10:00:01Z');
    // Competing explicit durations must be held, never silently preferred.
    add(10, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(10, 'user_updated', 50, '2026-10-10T10:00:00Z');
    add(10, 'data_usage_reset', 50, '2026-10-10T10:00:01Z', 1, '5184000');
    // Multiple unchanged Updates cannot prove a unique Reset duration.
    add(11, 'user_created', 50, '2026-10-10T09:00:00Z');
    add(11, 'user_updated', 50, '2026-10-10T10:00:00Z');
    add(11, 'data_usage_reset', 50, '2026-10-10T10:00:01Z', 1, null);
    add(11, 'user_updated', 50, '2026-10-10T10:00:02Z');

    for (const [index, row] of events.entries()) {
      await db.query(
        `INSERT INTO pasarguard_events (
          batch_id,batch_index,source_instance_id,semantic_fingerprint,
          action,external_user_id,username,user_status,data_limit_bytes,
          used_traffic_bytes,lifetime_used_bytes,billing_admin_id,
          billing_admin_username,source_enqueued_at,event_status,
          first_seen_at,last_seen_at,on_hold_expire_duration_seconds
        ) VALUES ($1,$2,'replay-30d',$3,$4,$5,$6,'active',$7,
          0,0,$8,'synthetic-admin',$9,'READY_FOR_ACCOUNTING',now(),now(),$10)`,
        [
          batch!.id,
          index,
          String(100 + index).padStart(64, '0'),
          row.action,
          String(row.user),
          `synthetic-user-${row.user}-${row.admin}`,
          row.bytes,
          String(row.admin),
          row.at,
          row.duration,
        ],
      );
    }
    const testCatalog = packages.map((pkg, index) =>
      index === 2
        ? { ...pkg, packageBytes: gb(100), amountToman: '350000' }
        : pkg,
    );
    const query = (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM fair_atomic_packages'))
        return Promise.resolve(testCatalog);
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
    const reader = new PostgresShadowReader(
      { query } as never,
      'Asia/Tehran',
      120,
    );
    const result = await reader.replayUpdateResetPreview();
    expect(result).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
      updateEventCount: 12,
      resetEventCount: 9,
      pairedRenewalCount: 2,
      pairedResetContextCount: 2,
      pricedRenewalCount: 2,
      pricedResetContextCount: 1,
      pricedUpdateOnlyCount: 2,
      pricedStandaloneResetCount: 2,
      decreaseUpdateCount: 1,
      unchangedUpdateCount: 0,
      heldOperationCount: 9,
      updateResetSubtotalToman: '1950000',
    });
    expect(result.heldReasons).toContainEqual({
      code: 'AMBIGUOUS_CORRELATION',
      count: 8,
    });
    expect(result.heldReasons).toContainEqual({
      code: 'DURATION_CONFLICT',
      count: 1,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-user-');
    expect(JSON.stringify(result)).not.toContain('synthetic-admin');
    expect(query.toString()).not.toContain('DELETE FROM fair_shadow');
  }, 120000);
});

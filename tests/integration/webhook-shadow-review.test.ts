import { expect, it } from 'vitest';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { NightlyShadow } from '../../apps/api/dist/owner/infrastructure/nightly-shadow.js';
import { PostgresShadowReader } from '../../apps/api/dist/owner/infrastructure/shadow-reader.js';

it('holds only one admin/day and books a reviewed package once on its original day', async () => {
  const pg = await startPostgres();
  const db = createOwnerDataSource(pg.getConnectionUri());
  try {
    await db.initialize();
    await db.runMigrations();
    const [pkg] = await db.query<
      { id: string }[]
    >(`INSERT INTO fair_atomic_packages
      (source_instance_id,name,package_bytes,duration_days,amount_toman)
      VALUES('primary','Pilot 50',53687091200,30,100000) RETURNING id::text`);
    const [batch] = await db.query<
      { id: string }[]
    >(`INSERT INTO pasarguard_webhook_batches
      (source_instance_id,received_at,payload_hash,event_count,processing_status)
      VALUES('primary',now(),repeat('a',64),4,'NORMALIZED') RETURNING id::text`);
    const ids: string[] = [];
    for (const [i, admin, day, action] of [
      [0, 17, 20, 'user_updated'],
      [1, 17, 20, 'data_usage_reset'],
      [2, 18, 20, 'user_created'],
      [3, 17, 21, 'user_created'],
    ] as const) {
      const [event] = await db.query<{ id: string }[]>(
        `INSERT INTO pasarguard_events
        (batch_id,batch_index,source_instance_id,semantic_fingerprint,action,external_user_id,
        username,user_status,data_limit_bytes,used_traffic_bytes,lifetime_used_bytes,billing_admin_id,
        billing_admin_username,source_enqueued_at,event_status,first_seen_at,last_seen_at,on_hold_expire_duration_seconds)
        VALUES($1,$2,'primary',$3,$4,900,'sample','on_hold',53687091200,0,0,$5,'admin',$6,'READY_FOR_ACCOUNTING',$6,$6,2592000)
        RETURNING id::text`,
        [
          batch!.id,
          i,
          String(i + 1).padStart(64, '0'),
          action,
          admin,
          `2026-11-${day}T12:0${i}:00Z`,
        ],
      );
      ids.push(event!.id);
    }
    const nightly = new NightlyShadow(db, 'UTC');
    await nightly.run(new Date('2026-11-22T02:20:00Z'));
    const reader = new PostgresShadowReader(db, 'UTC');
    const filter = {
      admin: null,
      source: 'primary',
      reason: null,
      date: null,
      limit: 25,
      offset: 0,
    };
    const key = crypto.randomUUID();
    expect(await reader.review(key, ids.slice(0, 2), pkg!.id)).toBe(true);
    expect(await reader.review(key, ids.slice(0, 2), pkg!.id)).toBe(true);
    expect(await reader.review(crypto.randomUUID(), [ids[0]!], pkg!.id)).toBe(
      false,
    );
    const days = await reader.dayReports(filter);
    expect(days).toHaveLength(3);
    expect(days.filter((d) => d.pending === 0)).toEqual([
      expect.objectContaining({
        admin: '17',
        amountToman: '100000',
        soldBytes: '53687091200',
      }),
    ]);
    expect(await reader.review(crypto.randomUUID(), [ids[2]!], null)).toBe(
      true,
    );
    expect(
      (await reader.dayReports(filter)).filter((d) => d.pending > 0),
    ).toHaveLength(1);
  } finally {
    if (db.isInitialized) await db.destroy();
    await pg.stop();
  }
}, 120000);

import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  db.setOptions({ extra: { statement_timeout: 60000 } }); // Synthetic bulk setup only.
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  await db.query(`INSERT INTO pasarguard_webhook_batches(source_instance_id,received_at,payload_hash,event_count,processing_status)
    SELECT 'synthetic-'||(n%8), '2026-01-01'::timestamptz + n * interval '2 minutes', lpad(n::text,64,'0'),1,'NORMALIZED'
    FROM generate_series(1,120000) n`);
  await db.query(`INSERT INTO pasarguard_events(batch_id,batch_index,source_instance_id,semantic_fingerprint,action,external_user_id,username,user_status,data_limit_bytes,used_traffic_bytes,lifetime_used_bytes,billing_admin_id,billing_admin_username,source_enqueued_at,event_status,first_seen_at,last_seen_at,created_at)
    SELECT id,0,source_instance_id,payload_hash,'user_create',id,'synthetic','active',0,0,0,1,'synthetic',received_at,'READY_FOR_ACCOUNTING',received_at,received_at,received_at FROM pasarguard_webhook_batches`);
  await db.query('ANALYZE pasarguard_webhook_batches');
  await db.query('ANALYZE pasarguard_events');
}, 120000);
afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});
it('measures source-filtered and all-source receipt, creation and ordered source-time plans on PostgreSQL 17', async () => {
  await db.destroy();
  db.setOptions({ extra: { statement_timeout: 5000 } });
  await db.initialize();
  const queries = [
    ['receipt', 'pasarguard_webhook_batches', 'received_at', 'COUNT(*)'],
    ['created', 'pasarguard_events', 'created_at', 'COUNT(*)'],
    [
      'source-time',
      'pasarguard_events',
      'source_enqueued_at',
      'id,source_enqueued_at',
    ],
  ];
  const evidence: unknown[] = [];
  await db.undoLastMigration({ transaction: 'all' });
  for (const stage of ['before', 'after']) {
    if (stage === 'after') {
      await db.runMigrations({ transaction: 'all' });
    }
    for (const [kind, table, time, select] of queries)
      for (const source of [false, true]) {
        const sql = `SELECT ${select} FROM ${table} WHERE ${time} >= '2026-06-01' AND ${time} < '2026-06-02' ${source ? "AND source_instance_id='synthetic-1'" : ''} ${kind === 'source-time' ? 'ORDER BY source_enqueued_at DESC,id DESC LIMIT 26' : ''}`;
        const result = await db.query<
          {
            'QUERY PLAN': {
              Plan: { 'Actual Rows': number };
              'Execution Time': number;
            }[];
          }[]
        >('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql);
        const plan = result[0]!['QUERY PLAN'][0]!;
        evidence.push({ stage, kind, source, plan });
        expect(plan.Plan['Actual Rows']).toBeGreaterThan(0);
        if (stage === 'after')
          expect(JSON.stringify(plan)).not.toContain('Seq Scan');
      }
  }
  if (process.env.QUERY_PLAN_EVIDENCE_FILE)
    writeFileSync(
      process.env.QUERY_PLAN_EVIDENCE_FILE,
      JSON.stringify(evidence, null, 2),
    );
}, 120000);

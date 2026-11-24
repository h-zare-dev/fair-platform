import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresReplayShadowJournal } from '../../apps/api/dist/owner/infrastructure/replay-shadow-journal.js';
import { PostgresReplayShadowAudit } from '../../apps/api/dist/owner/infrastructure/replay-shadow-audit.js';

let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;

beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  const [group] = await db.query<{ id: string }[]>(
    `INSERT INTO fair_admin_groups(source_instance_id,name)
       VALUES('primary','Archived test pricing') RETURNING id::text`,
  );
  await db.query(`INSERT INTO fair_atomic_packages
     (source_instance_id,name,package_bytes,duration_days,amount_toman)
     SELECT 'primary','Archive shape '||n,1073741824::bigint*50*n,30,
       100000*n FROM generate_series(1,25) AS n`);
  await db.query(
    `INSERT INTO fair_tariff_assignments
    (source_instance_id,target_kind,group_id,package_id,package_bytes,
     duration_days,local_start_date,time_zone,effective_from)
    SELECT 'primary','GROUP',$1,p.id,p.package_bytes,p.duration_days,
      '1405-01-01','Asia/Tehran','2026-03-21T00:00:00Z'
    FROM fair_atomic_packages p WHERE p.source_instance_id='primary'`,
    [group!.id],
  );
  const [batch] = await db.query<{ id: string }[]>(
    `INSERT INTO pasarguard_webhook_batches
     (source_instance_id,received_at,payload_hash,event_count,processing_status)
     VALUES('replay-30d',now(),repeat('a',64),2,'NORMALIZED') RETURNING id::text`,
  );
  for (const [index, action] of ['user_created', 'user_deleted'].entries()) {
    await db.query(
      `INSERT INTO pasarguard_events
       (batch_id,batch_index,source_instance_id,semantic_fingerprint,action,
        external_user_id,username,user_status,data_limit_bytes,used_traffic_bytes,
        lifetime_used_bytes,billing_admin_id,billing_admin_username,
        source_enqueued_at,event_status,first_seen_at,last_seen_at,
        on_hold_expire_duration_seconds)
      VALUES($1,$2,'replay-30d',$3,$4,900,'sample','on_hold',53687091200,0,0,
        17,'admin','2026-11-20T12:00:00Z'::timestamptz+
          $2::integer*interval '1 minute','READY_FOR_ACCOUNTING',now(),now(),2592000)`,
      [batch!.id, index, String(index + 1).padStart(64, '0'), action],
    );
  }
}, 120000);
afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});

describe('FP-006/007 archival SHADOW financial journal', () => {
  async function runWithPolicy(credit: boolean) {
    const [run] = await db.query<{ id: string }[]>(
      `INSERT INTO fair_replay_shadow_runs
        (request_key,time_zone,correlation_window_seconds,delete_credit_enabled)
       VALUES($1,'Asia/Tehran',600,$2) RETURNING id::text`,
      [crypto.randomUUID(), credit],
    );
    const journal = new PostgresReplayShadowJournal(
      db,
      'Asia/Tehran',
      600,
      credit,
    );
    expect(await journal.runNext()).toBe(true);
    const summary = await journal.summary();
    expect(summary.run?.status).toBe('COMPLETE');
    expect(summary.run?.id).toBe(run!.id);
    return { journal, run: run!.id, summary };
  }

  it('posts a complete full-price historical charge without a deletion credit by default', async () => {
    const { run, summary } = await runWithPolicy(false);
    expect(summary).toMatchObject({
      postingScope: 'SHADOW',
      liveBalanceMutated: false,
      run: {
        entryCount: 1,
        heldCount: 0,
        chargesToman: '100000',
        creditsToman: '0',
        netToman: '100000',
      },
    });
    expect(
      await db.query(
        `SELECT entry_type,amount_toman::text
      FROM fair_replay_shadow_entries WHERE run_id=$1`,
        [run],
      ),
    ).toMatchObject([{ entry_type: 'CHARGE', amount_toman: '100000' }]);
    await expect(
      db.query('DELETE FROM fair_replay_shadow_entries WHERE run_id=$1', [run]),
    ).rejects.toThrow('REPLAY_SHADOW_EVIDENCE_IMMUTABLE');
    expect(
      await db.query(
        'SELECT COUNT(*)::text AS count FROM fair_replay_shadow_audit_prices WHERE run_id=$1',
        [run],
      ),
    ).toEqual([{ count: '25' }]);
    expect(
      await db.query(
        'SELECT action,reason,event_count FROM fair_replay_shadow_ignored_summary WHERE run_id=$1',
        [run],
      ),
    ).toMatchObject([
      {
        action: 'user_deleted',
        reason: 'DELETE_CREDIT_DISABLED',
        event_count: 1,
      },
    ]);
    const audit = new PostgresReplayShadowAudit(
      db,
      new PostgresReplayShadowJournal(db, 'Asia/Tehran', 600, false),
      'SATURDAY',
    );
    expect(await audit.overview(run)).toMatchObject({
      postingScope: 'SHADOW',
      liveBalanceMutated: false,
      integrity: { status: 'RECONCILED', errors: [] },
      totals: {
        chargesToman: '100000',
        creditsToman: '0',
        heldCandidates: 0,
        ignoredEvents: 1,
      },
    });
    const admins = await audit.admins({ runId: run, offset: 0, limit: 10 });
    expect(admins.rows[0]).toMatchObject({
      billingAdminId: '17',
      adminName: 'admin',
      chargeToman: '100000',
    });
    const entries = await audit.entries({
      runId: run,
      billingAdminId: '17',
      offset: 0,
      limit: 10,
    });
    expect(entries.rows[0]).toMatchObject({
      accountName: 'sample',
      adminName: 'admin',
      amountToman: '100000',
      packageBytes: (50n * 1073741824n).toString(),
      durationDays: 30,
      eventEvidenceComplete: true,
    });
    const periods = await audit.periods(
      { runId: run, billingAdminId: '17', offset: 0, limit: 10 },
      'day',
    );
    expect(periods.rows[0]).toMatchObject({
      status: 'RECONCILED',
      readyNetToman: '100000',
    });
  });

  it('credits the full last proven purchase when ENV is on; old run remains unchanged', async () => {
    const { run, summary } = await runWithPolicy(true);
    expect(summary).toMatchObject({
      postingScope: 'SHADOW',
      liveBalanceMutated: false,
      run: {
        entryCount: 2,
        heldCount: 0,
        chargesToman: '100000',
        creditsToman: '100000',
        netToman: '0',
      },
    });
    const lines = await db.query<
      { entry_type: string; reference_operation_key: string | null }[]
    >(
      `SELECT entry_type,reference_operation_key
       FROM fair_replay_shadow_entries WHERE run_id=$1 ORDER BY occurred_at`,
      [run],
    );
    expect(lines.map((line) => line.entry_type)).toEqual(['CHARGE', 'CREDIT']);
    expect(lines[1]?.reference_operation_key).toBeTruthy();
    const [other] = await db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM fair_replay_shadow_entries
       WHERE run_id<>$1 AND entry_type='CREDIT'`,
      [run],
    );
    expect(other?.count).toBe('0');
    expect(
      await db.query(
        "SELECT to_regclass('accounting_transactions')::text AS name",
      ),
    ).toEqual([{ name: null }]);
    expect(
      await db.query('SELECT COUNT(*)::text AS count FROM fair_shadow_days'),
    ).toEqual([{ count: '0' }]);
    expect(
      await new PostgresReplayShadowJournal(
        db,
        'Asia/Tehran',
        600,
        true,
      ).runNext(),
    ).toBe(false);
  });
});

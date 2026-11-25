import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresReplayShadowJournal } from '../../apps/api/dist/owner/infrastructure/replay-shadow-journal.js';
import { PostgresReplayShadowAudit } from '../../apps/api/dist/owner/infrastructure/replay-shadow-audit.js';

let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
let runId = '';
const gib = 1073741824n;

beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  const [group] = await db.query<{ id: string }[]>(
    `INSERT INTO fair_admin_groups(source_instance_id,name) VALUES('primary','Audit group') RETURNING id::text`,
  );
  await db.query(`INSERT INTO fair_atomic_packages
      (source_instance_id,name,package_bytes,duration_days,amount_toman)
      SELECT 'primary','Shape '||n,1073741824::bigint*50*n,30,100000*n
      FROM generate_series(1,25) n`);
  await db.query(
    `INSERT INTO fair_tariff_assignments
      (source_instance_id,target_kind,group_id,package_id,package_bytes,
       duration_days,local_start_date,time_zone,effective_from)
      SELECT 'primary','GROUP',$1,p.id,p.package_bytes,p.duration_days,
      '1405-01-01','Asia/Tehran','2026-03-21T00:00:00Z'
      FROM fair_atomic_packages p`,
    [group!.id],
  );
  const [batch] = await db.query<
    { id: string }[]
  >(`INSERT INTO pasarguard_webhook_batches
      (source_instance_id,received_at,payload_hash,event_count,processing_status)
      VALUES('replay-30d',now(),repeat('f',64),5,'NORMALIZED') RETURNING id::text`);
  const events = [
    {
      id: 0,
      action: 'user_created',
      accountId: '900',
      admin: '17',
      name: 'ali',
      adminName: 'reseller',
      duration: '2592000',
    },
    {
      id: 1,
      action: 'user_created',
      accountId: '901',
      admin: '17',
      name: 'reza',
      adminName: 'reseller',
      duration: '2592000',
    },
    {
      id: 2,
      action: 'user_updated',
      accountId: '902',
      admin: '17',
      name: 'neda',
      adminName: 'reseller',
      duration: null,
    },
    {
      id: 3,
      action: 'user_created',
      accountId: '903',
      admin: '18',
      name: 'sara',
      adminName: 'agency',
      duration: '2592000',
    },
    {
      id: 4,
      action: 'user_disabled',
      accountId: '903',
      admin: '18',
      name: 'sara',
      adminName: 'agency',
      duration: '2592000',
    },
  ];
  for (const e of events) {
    await db.query(
      `INSERT INTO pasarguard_events
      (batch_id,batch_index,source_instance_id,semantic_fingerprint,action,
       external_user_id,username,user_status,data_limit_bytes,used_traffic_bytes,
       lifetime_used_bytes,billing_admin_id,billing_admin_username,source_enqueued_at,
       event_status,first_seen_at,last_seen_at,on_hold_expire_duration_seconds)
      VALUES($1,$2,'replay-30d',$3,$4,$5,$6,'on_hold',$7,0,0,$8,$9,
        '2026-11-20T12:00:00Z'::timestamptz + $2::integer * interval '1 minute',
        'READY_FOR_ACCOUNTING',now(),now(),$10)`,
      [
        batch!.id,
        e.id,
        String(e.id + 1).padStart(64, '0'),
        e.action,
        e.accountId,
        e.name,
        (50n * gib).toString(),
        e.admin,
        e.adminName,
        e.duration,
      ],
    );
  }
  const [run] = await db.query<{ id: string }[]>(
    `INSERT INTO fair_replay_shadow_runs
      (request_key,time_zone,correlation_window_seconds,delete_credit_enabled)
      VALUES($1,'Asia/Tehran',600,false) RETURNING id::text`,
    [crypto.randomUUID()],
  );
  runId = run!.id;
  expect(
    await new PostgresReplayShadowJournal(
      db,
      'Asia/Tehran',
      600,
      false,
    ).runNext(),
  ).toBe(true);
}, 120000);

afterAll(async () => {
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});

describe('Owner SHADOW audit forensic evidence is isolated and complete', () => {
  const audit = () =>
    new PostgresReplayShadowAudit(
      db,
      new PostgresReplayShadowJournal(db, 'Asia/Tehran', 600, false),
      'SATURDAY',
    );

  it('holds both otherwise priceable Create candidates on one ambiguous admin/day', async () => {
    const overview = await audit().overview(runId);
    expect(overview).toMatchObject({
      integrity: { status: 'RECONCILED', errors: [] },
      run: { heldCount: 1, heldCandidateCount: 2, entryCount: 1 },
      totals: {
        readyDays: 1,
        pendingDays: 1,
        chargesToman: '100000',
        heldCandidates: 2,
      },
    });
    const candidates = await audit().candidates({
      runId,
      billingAdminId: '17',
      offset: 0,
      limit: 10,
    });
    expect(candidates.bookingStatus).toBe('NOT_BOOKED');
    expect(candidates.rows.map((r) => [r.accountName, r.amountToman])).toEqual([
      ['ali', '100000'],
      ['reza', '100000'],
    ]);
    const holds = await audit().holds({
      runId,
      billingAdminId: '17',
      offset: 0,
      limit: 10,
    });
    expect(holds.rows).toMatchObject([
      {
        code: 'PREVIOUS_STATE_MISSING',
        accountName: 'neda',
        eventEvidenceComplete: true,
      },
    ]);
    const pending = await audit().periods(
      { runId, billingAdminId: '17', offset: 0, limit: 10 },
      'day',
    );
    expect(pending.rows[0]).toMatchObject({
      status: 'PENDING_REVIEW',
      readyChargeToman: '0',
      chargeToman: null,
      netToman: null,
      holdCount: 1,
      entryCount: 0,
    });
    const entries = await audit().entries({
      runId,
      billingAdminId: '17',
      offset: 0,
      limit: 10,
    });
    expect(entries.rows).toHaveLength(0);
  });

  it('reconciles the independent admin/day and ignored-event breakdown without financial mutation', async () => {
    const admins = await audit().admins({
      runId,
      search: 'agency',
      offset: 0,
      limit: 10,
    });
    expect(admins.rows).toMatchObject([
      {
        billingAdminId: '18',
        adminName: 'agency',
        status: 'RECONCILED',
        netToman: '100000',
      },
    ]);
    const events = await audit().ignored({ runId, offset: 0, limit: 10 });
    expect(events).toMatchObject({
      totalIgnored: 1,
      rows: [
        { action: 'user_disabled', reason: 'NONFINANCIAL_ACTION', count: 1 },
      ],
    });
    expect(
      await db.query('SELECT COUNT(*)::text AS count FROM fair_shadow_days'),
    ).toEqual([{ count: '0' }]);
    await expect(
      db.query(
        'DELETE FROM fair_replay_shadow_held_candidates WHERE run_id=$1',
        [runId],
      ),
    ).rejects.toThrow('REPLAY_SHADOW_EVIDENCE_IMMUTABLE');
  });

  it('shows source-verified historical names only on matching archived ID + username, keeping amounts unchanged', async () => {
    const before = await audit().overview(runId);
    expect(before.historicalSourceIdentity?.status).toBe('NOT_IMPORTED');
    await db.query(`INSERT INTO fair_replay_private_identity_imports
      (source_instance_id,manifest_sha256,map_sha256,replay_plaintext_sha256,source_script_sha256,
        event_count,mapped_admins,mapped_accounts,mapped_actor_admins,
        unmatched_admin_pairs,unmatched_account_pairs,unmatched_actor_pairs)
      VALUES('replay-30d',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),64135,1,1,0,1,0,0)`);
    await db.query(`INSERT INTO fair_replay_private_identity_aliases
      (source_instance_id,role,archived_id,archived_username,original_id,original_username)
      VALUES
        ('replay-30d','billing_admin',18,'agency',208,'historical-owner'),
        ('replay-30d','account',903,'sara',1903,'historical-account'),
        ('replay-30d','billing_admin',17,'different-alias',207,'must-not-show')`);
    const names = await audit().admins({
      runId,
      search: 'historical-owner',
      offset: 0,
      limit: 10,
    });
    expect(names.rows).toMatchObject([
      {
        billingAdminId: '18',
        historicalAdminId: '208',
        adminName: 'historical-owner',
        nameStatus: 'SOURCE_VERIFIED_HISTORICAL',
      },
    ]);
    const unmatched = await audit().admins({
      runId,
      search: '17',
      offset: 0,
      limit: 10,
    });
    expect(unmatched.rows[0]).toMatchObject({
      billingAdminId: '17',
      adminName: 'reseller',
      historicalAdminId: null,
      nameStatus: 'VERIFIED_IN_ARCHIVE',
    });
    const entries = await audit().entries({
      runId,
      billingAdminId: '18',
      offset: 0,
      limit: 10,
    });
    expect(entries.rows[0]).toMatchObject({
      adminName: 'historical-owner',
      accountName: 'historical-account',
      adminNameStatus: 'SOURCE_VERIFIED_HISTORICAL',
      accountNameStatus: 'SOURCE_VERIFIED_HISTORICAL',
      events: [
        {
          historicalBillingAdminId: '208',
          historicalAccountId: '1903',
          archivedAccountUsername: 'sara',
        },
      ],
    });
    const after = await audit().overview(runId);
    expect(after.totals).toEqual(before.totals);
    expect(after.integrity).toEqual(before.integrity);
    expect(after.historicalIdentityVerified).toBe(false); // no current-directory proof
    expect(after.historicalSourceIdentity?.status).toBe('PARTIAL_SOURCE_MATCH');
  });
});

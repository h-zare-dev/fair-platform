import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { validateTimeZone } from '@fair-platform/calendar';
import { PostgresShadowReader } from './shadow-reader.js';
import {
  calculateReplayShadow,
  type ReplayFixedPrice,
  type ReplaySourceEvent,
} from './replay-shadow-calculator.js';

const SOURCE = 'replay-30d';
const MAX_EVENTS = 70000;
const INSERT_BATCH = 200;

export class ReplayShadowBusy extends Error {
  constructor() {
    super('REPLAY_SHADOW_ALREADY_RUNNING');
  }
}
export class ReplayShadowNotReady extends Error {
  constructor() {
    super('REPLAY_SHADOW_CONFIGURATION_INCOMPLETE');
  }
}

interface RunRow {
  id: string;
  status: 'PENDING' | 'COMPLETE' | 'FAILED';
  time_zone: string;
  correlation_window_seconds: number;
  delete_credit_enabled: boolean;
}

/** An entirely separate immutable test ledger: no LIVE, no PasarGuard debit. */
export class PostgresReplayShadowJournal {
  private readonly zone: string;
  constructor(
    private readonly db: DataSource,
    timeZone: string,
    private readonly correlationWindowSeconds: number,
    private readonly deleteCreditEnabled: boolean,
  ) {
    this.zone = validateTimeZone(timeZone);
    if (
      !Number.isInteger(correlationWindowSeconds) ||
      correlationWindowSeconds < 1 ||
      correlationWindowSeconds > 600
    )
      throw new RangeError('INVALID_CORRELATION_WINDOW');
  }

  async start(requestKey: string = randomUUID()) {
    // A retry must always refer to the original immutable run, even if
    // the archive/catalog changed after the first successful request.
    const [prior] = await this.db.query<{ id: string; status: string }[]>(
      `SELECT id::text,status FROM fair_replay_shadow_runs
       WHERE request_key=$1::uuid`,
      [requestKey],
    );
    if (prior) return prior;
    // Do not enqueue a misleading journal before both the exact archive and
    // the Owner-attested current 25-shape/153-member catalog are verified.
    const preflight = await new PostgresShadowReader(
      this.db,
      this.zone,
      this.correlationWindowSeconds,
    ).replayPreview();
    if (!preflight.configurationReady || !preflight.ingestionReady)
      throw new ReplayShadowNotReady();
    try {
      const [existing] = await this.db.query<{ id: string; status: string }[]>(
        `SELECT id::text,status FROM fair_replay_shadow_runs
        WHERE request_key=$1::uuid`,
        [requestKey],
      );
      if (existing) return existing;
      const [run] = await this.db.query<{ id: string; status: string }[]>(
        `INSERT INTO fair_replay_shadow_runs
          (request_key,source_instance_id,time_zone,correlation_window_seconds,
           delete_credit_enabled)
         VALUES ($1::uuid,$2,$3,$4,$5) RETURNING id::text,status`,
        [
          requestKey,
          SOURCE,
          this.zone,
          this.correlationWindowSeconds,
          this.deleteCreditEnabled,
        ],
      );
      if (!run) throw new Error('REPLAY_SHADOW_START_FAILED');
      return run;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const [already] = await this.db.query<{ id: string; status: string }[]>(
          `SELECT id::text,status FROM fair_replay_shadow_runs
          WHERE request_key=$1::uuid`,
          [requestKey],
        );
        if (already) return already;
        throw new ReplayShadowBusy();
      }
      throw error;
    }
  }

  async summary() {
    const [run] = await this.db.query<
      {
        id: string;
        status: string;
        source_instance_id: string;
        time_zone: string;
        correlation_window_seconds: number;
        delete_credit_enabled: boolean;
        catalog_hash: string | null;
        event_count: number;
        ignored_count: number;
        entry_count: number;
        held_count: number;
        held_candidate_count: number;
        failure_code: string | null;
        created_at: Date;
        finished_at: Date | null;
      }[]
    >(`SELECT id::text,status,source_instance_id,time_zone,
      correlation_window_seconds,delete_credit_enabled,catalog_hash,
      event_count,ignored_count,entry_count,held_count,held_candidate_count,
      failure_code,created_at,finished_at
      FROM fair_replay_shadow_runs ORDER BY id DESC LIMIT 1`);
    if (!run)
      return {
        mode: 'HISTORICAL_SHADOW_LEDGER',
        postingScope: 'SHADOW',
        liveBalanceMutated: false,
        configuredDeleteCreditEnabled: this.deleteCreditEnabled,
        run: null,
      };
    const [totals] = await this.db.query<
      {
        ready_days: string;
        pending_days: string;
        charges: string;
        credits: string;
        net: string;
      }[]
    >(
      `SELECT COUNT(*) FILTER(WHERE status='SHADOW_READY')::text AS ready_days,
      COUNT(*) FILTER(WHERE status='PENDING_REVIEW')::text AS pending_days,
      COALESCE(SUM(charge_toman),0)::text AS charges,
      COALESCE(SUM(credit_toman),0)::text AS credits,
      COALESCE(SUM(net_toman),0)::text AS net
      FROM fair_replay_shadow_days WHERE run_id=$1`,
      [run.id],
    );
    const [reasons, packageTotals] = await Promise.all([
      this.db.query<{ code: string; count: string }[]>(
        `SELECT reason_code AS code,COUNT(*)::text AS count
          FROM fair_replay_shadow_holds WHERE run_id=$1
          GROUP BY reason_code ORDER BY count DESC,reason_code LIMIT 50`,
        [run.id],
      ),
      this.db.query<
        {
          packageId: string;
          kind: string;
          entryType: string;
          operationCount: string;
          totalToman: string;
        }[]
      >(
        `SELECT package_id::text AS "packageId",kind,
          entry_type AS "entryType",COUNT(*)::text AS "operationCount",
          SUM(amount_toman)::text AS "totalToman"
          FROM fair_replay_shadow_entries WHERE run_id=$1
          GROUP BY package_id,kind,entry_type
          ORDER BY package_id,kind,entry_type LIMIT 200`,
        [run.id],
      ),
    ]);
    return {
      mode: 'HISTORICAL_SHADOW_LEDGER' as const,
      postingScope: 'SHADOW' as const,
      liveBalanceMutated: false as const,
      configuredDeleteCreditEnabled: this.deleteCreditEnabled,
      assumption: 'OWNER_ATTESTED_25_STATIC_PRICES_ALL_ARCHIVE_ADMINS' as const,
      run: {
        id: run.id,
        status: run.status,
        source: run.source_instance_id,
        timeZone: run.time_zone,
        correlationWindowSeconds: run.correlation_window_seconds,
        deleteCreditEnabled: run.delete_credit_enabled,
        catalogHash: run.catalog_hash,
        eventCount: run.event_count,
        ignoredCount: run.ignored_count,
        entryCount: run.entry_count,
        heldCount: run.held_count,
        heldCandidateCount: run.held_candidate_count,
        failureCode: run.failure_code,
        createdAt: run.created_at.toISOString(),
        finishedAt: run.finished_at?.toISOString() ?? null,
        readyDays: Number(totals?.ready_days ?? 0),
        pendingDays: Number(totals?.pending_days ?? 0),
        chargesToman: totals?.charges ?? '0',
        creditsToman: totals?.credits ?? '0',
        netToman: totals?.net ?? '0',
        heldReasons: reasons.map((row) => ({
          code: row.code,
          count: Number(row.count),
        })),
        packageTotals: packageTotals.map((row) => ({
          ...row,
          operationCount: Number(row.operationCount),
        })),
      },
    };
  }

  /** One transaction atomically produces all hypothetical financial evidence.
   * An interrupted process rolls back completely, leaving PENDING retriable. */
  async runNext(): Promise<boolean> {
    let claimedId: string | null = null;
    try {
      return await this.db.transaction('SERIALIZABLE', async (tx) => {
        const [run] = await tx.query<RunRow[]>(
          `SELECT id::text,status,time_zone,correlation_window_seconds,
            delete_credit_enabled FROM fair_replay_shadow_runs
           WHERE status='PENDING' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (!run) return false;
        claimedId = run.id;
        const prices = await this.readPrices(tx);
        const sourceEvents = await this.readEvents(tx);
        const priced = calculateReplayShadow(sourceEvents, prices, {
          timeZone: run.time_zone,
          correlationWindowSeconds: run.correlation_window_seconds,
          deleteCreditEnabled: run.delete_credit_enabled,
        });
        const catalogHash = createHash('sha256')
          .update(JSON.stringify(prices))
          .digest('hex');
        await this.batchInsert(
          tx,
          `INSERT INTO fair_replay_shadow_days
            (run_id,billing_admin_id,local_day,status,charge_toman,credit_toman,
             net_toman,entry_count,hold_count)
           SELECT $1,v.billing_admin_id,v.local_day,v.status,v.charge_toman,
             v.credit_toman,v.net_toman,v.entry_count,v.hold_count
           FROM jsonb_to_recordset($2::jsonb) AS v(
             billing_admin_id bigint,local_day varchar(10),status varchar(20),
             charge_toman bigint,credit_toman bigint,net_toman bigint,
             entry_count integer,hold_count integer)`,
          run.id,
          priced.days.map((d) => ({
            billing_admin_id: d.billingAdminId,
            local_day: d.localDay,
            status: d.status,
            charge_toman: d.totalChargeToman,
            credit_toman: d.totalCreditToman,
            net_toman: d.netToman,
            entry_count: d.entryCount,
            hold_count: d.holdCount,
          })),
        );
        await this.batchInsert(
          tx,
          `INSERT INTO fair_replay_shadow_entries
            (run_id,operation_key,kind,entry_type,billing_admin_id,external_user_id,
             local_day,occurred_at,source_event_ids,amount_toman,package_id,reference_operation_key)
           SELECT $1,v.operation_key,v.kind,v.entry_type,v.billing_admin_id,
             v.external_user_id,v.local_day,v.occurred_at,v.source_event_ids,
             v.amount_toman,v.package_id,v.reference_operation_key
           FROM jsonb_to_recordset($2::jsonb) AS v(
             operation_key varchar(128),kind varchar(32),entry_type varchar(8),
             billing_admin_id bigint,external_user_id bigint,local_day varchar(10),
             occurred_at timestamptz,source_event_ids bigint[],amount_toman bigint,
             package_id bigint,reference_operation_key varchar(128))`,
          run.id,
          priced.entries.map((entry) => ({
            operation_key: entry.operationKey,
            kind: entry.kind,
            entry_type: entry.entryType,
            billing_admin_id: entry.billingAdminId,
            external_user_id: entry.externalUserId,
            local_day: entry.localDay,
            occurred_at: entry.occurredAt,
            source_event_ids: entry.eventIds,
            amount_toman: entry.amountToman,
            package_id: entry.packageId,
            reference_operation_key: entry.referenceOperationKey,
          })),
        );
        await this.batchInsert(
          tx,
          `INSERT INTO fair_replay_shadow_holds
            (run_id,operation_key,reason_code,billing_admin_id,external_user_id,
             local_day,occurred_at,source_event_ids)
           SELECT $1,v.operation_key,v.reason_code,v.billing_admin_id,
             v.external_user_id,v.local_day,v.occurred_at,v.source_event_ids
           FROM jsonb_to_recordset($2::jsonb) AS v(
             operation_key varchar(128),reason_code varchar(64),
             billing_admin_id bigint,external_user_id bigint,local_day varchar(10),
             occurred_at timestamptz,source_event_ids bigint[])`,
          run.id,
          priced.holds.map((h) => ({
            operation_key: h.operationKey,
            reason_code: h.code,
            billing_admin_id: h.billingAdminId,
            external_user_id: h.externalUserId,
            local_day: h.localDay,
            occurred_at: h.occurredAt,
            source_event_ids: h.eventIds,
          })),
        );
        await tx.query(
          `UPDATE fair_replay_shadow_runs SET
          status='COMPLETE',catalog_hash=$2,event_count=$3,ignored_count=$4,
          entry_count=$5,held_count=$6,held_candidate_count=$7,
          finished_at=clock_timestamp() WHERE id=$1 AND status='PENDING'`,
          [
            run.id,
            catalogHash,
            priced.analyzedEvents,
            priced.ignoredEvents,
            priced.entries.length,
            priced.holds.length,
            priced.candidateEntriesHeld,
          ],
        );
        return true;
      });
    } catch {
      // A failed replay may never create a partial journal; keep a fixed safe
      // diagnostic code, with no raw archive event or credentials in logs.
      if (claimedId !== null)
        await this.db.query(
          `UPDATE fair_replay_shadow_runs
        SET status='FAILED',failure_code='REPLAY_SHADOW_CALCULATION_FAILED',
          finished_at=clock_timestamp()
        WHERE id=$1 AND status='PENDING'`,
          [claimedId],
        );
      return true;
    }
  }

  private async batchInsert(
    tx: EntityManager,
    sql: string,
    runId: string,
    records: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += INSERT_BATCH) {
      await tx.query(sql, [
        runId,
        JSON.stringify(records.slice(offset, offset + INSERT_BATCH)),
      ]);
    }
  }

  private async readPrices(tx: EntityManager): Promise<ReplayFixedPrice[]> {
    const rows = await tx.query<
      {
        packageId: string;
        bytes: string;
        days: number;
        amountToman: string;
      }[]
    >(`SELECT p.id::text AS "packageId",p.package_bytes::text AS bytes,
      p.duration_days AS days,p.amount_toman::text AS "amountToman"
      FROM fair_atomic_packages p
      JOIN fair_tariff_assignments a ON a.package_id=p.id
      WHERE p.source_instance_id='primary' AND a.source_instance_id='primary'
        AND a.target_kind='GROUP' AND a.rate_toman_per_gib IS NULL
      ORDER BY p.id LIMIT 26`);
    if (
      rows.length !== 25 ||
      new Set(rows.map((r) => `${r.bytes}:${r.days}`)).size !== 25
    )
      throw new ReplayShadowNotReady();
    return rows;
  }

  private async readEvents(tx: EntityManager): Promise<ReplaySourceEvent[]> {
    const rows = await tx.query<ReplaySourceEvent[]>(
      `SELECT id::text AS id,action,
         billing_admin_id::text AS "billingAdminId",
         external_user_id::text AS "externalUserId",
         to_char(source_enqueued_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceTimestamp",
         data_limit_bytes::text AS "dataLimitBytes",
         on_hold_expire_duration_seconds::text AS "durationSeconds",
         event_status AS "eventStatus",user_status AS "userStatus",
         to_char(source_user_created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceUserCreatedAt",
         to_char(source_user_expire_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceUserExpiresAt"
       FROM pasarguard_events WHERE source_instance_id=$1
       ORDER BY source_enqueued_at,id LIMIT $2`,
      [SOURCE, MAX_EVENTS + 1],
    );
    if (rows.length > MAX_EVENTS)
      throw new Error('REPLAY_SHADOW_EVENTS_EXCEED_LIMIT');
    return rows;
  }
}

import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { localJalaliDate } from '@fair-platform/calendar';
import {
  groupShadowReportDays,
  type ReportPeriod,
  type ReportWeekStart,
  type StoredShadowDay,
} from '../application/shadow-report-periods.js';
import { archivedAdminNameStatus } from '../application/archive-admin-name.js';
import type { PostgresReplayShadowJournal } from './replay-shadow-journal.js';
import {
  replayManualReviewKey,
  type ReplayLedgerLine,
} from './replay-shadow-calculator.js';

import {
  fullArchiveDays,
  replayReviewFingerprintSql,
} from './replay-archive.js';
const LEGACY_IDENTITY_SOURCE = 'replay-30d';

function identitySource(source: string): string {
  // Extended exports reuse the legacy exporter's anonymization. Match each
  // role, archived ID and alias before presenting any historical identity.
  return source.startsWith('replay-archive-') ? LEGACY_IDENTITY_SOURCE : source;
}

export class ShadowAuditNotFound extends Error {}
export class ShadowAuditIncomplete extends Error {}

interface RunRow {
  id: string;
  status: string;
  time_zone: string;
  source_instance_id: string;
  correlation_window_seconds: number;
  delete_credit_enabled: boolean;
  catalog_hash: string | null;
  event_count: number;
  entry_count: number;
  held_count: number;
  held_candidate_count: number;
  ignored_count: number;
  created_at: Date;
  finished_at: Date | null;
}
interface EntryRow {
  operationKey: string;
  kind: string;
  entryType: string;
  billingAdminId: string;
  externalUserId: string;
  localDay: string;
  occurredAt: string;
  eventIds: string[];
  amountToman: string;
  packageId: string;
  referenceOperationKey: string | null;
  similarRenewal?: boolean;
  packageBytes: string | null;
  durationDays: number | null;
}
interface HoldRow {
  operationKey: string;
  code: string;
  billingAdminId: string;
  externalUserId: string;
  localDay: string;
  occurredAt: string;
  eventIds: string[];
}

export interface AuditPageFilters {
  runId?: string | undefined;
  billingAdminId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  reason?: string | undefined;
  kind?: string | undefined;
  search?: string | undefined;
  offset: number;
  limit: number;
}

const int = (v: string | number): string => BigInt(v).toString();
const page = <T>(rows: T[], limit: number, offset: number) => ({
  rows: rows.slice(0, limit),
  nextOffset: rows.length > limit ? offset + limit : null,
});

/** Owner-only read models of immutable SHADOW evidence, not a settlement path. */
export class PostgresReplayShadowAudit {
  constructor(
    private readonly db: DataSource,
    private readonly journal: PostgresReplayShadowJournal,
    readonly weekStartDay: ReportWeekStart,
  ) {}

  private async runs(): Promise<RunRow[]> {
    return this.db.query<
      RunRow[]
    >(`SELECT id::text,status,time_zone,source_instance_id,
      correlation_window_seconds,delete_credit_enabled,catalog_hash,
      event_count,entry_count,held_count,held_candidate_count,ignored_count,
      created_at,finished_at
      FROM fair_replay_shadow_runs ORDER BY id DESC LIMIT 30`);
  }

  private async resolve(runId?: string): Promise<RunRow> {
    const runs = await this.runs();
    const chosen = runId
      ? runs.find((r) => r.id === runId)
      : runs.find((r) => r.status === 'COMPLETE');
    if (!chosen) throw new ShadowAuditNotFound('SHADOW_AUDIT_RUN_NOT_FOUND');
    if (chosen.status !== 'COMPLETE')
      throw new ShadowAuditIncomplete('SHADOW_AUDIT_RUN_NOT_COMPLETE');
    return chosen;
  }

  private async coverage(run: RunRow): Promise<{
    from: string | null;
    to: string | null;
    eventCount: number;
    verifiedBoundaries: boolean;
  }> {
    const zone = run.time_zone;
    if (run.source_instance_id !== 'replay-30d') {
      const [archive] = await this.db.query<
        Array<{
          starts_at: Date;
          cutoff_at: Date;
          event_count: string;
        }>
      >(
        `SELECT starts_at,cutoff_at,
          (SELECT COUNT(*)::text FROM pasarguard_events WHERE source_instance_id=$1) AS event_count
         FROM fair_replay_archives WHERE source_instance_id=$1`,
        [run.source_instance_id],
      );
      if (!archive) throw new ShadowAuditIncomplete('SHADOW_ARCHIVE_NOT_FOUND');
      return {
        ...fullArchiveDays(archive.starts_at, archive.cutoff_at, zone),
        eventCount: Number(archive.event_count),
        verifiedBoundaries: true,
      };
    }
    const [row] = await this.db.query<
      {
        min_at: Date | null;
        max_at: Date | null;
        count: string;
      }[]
    >(
      `SELECT MIN(source_enqueued_at) AS min_at,MAX(source_enqueued_at) AS max_at,
      COUNT(*)::text AS count FROM pasarguard_events WHERE source_instance_id=$1`,
      [run.source_instance_id],
    );
    return {
      from: row?.min_at ? localJalaliDate(row.min_at, zone) : null,
      to: row?.max_at ? localJalaliDate(row.max_at, zone) : null,
      eventCount: Number(row?.count ?? 0),
      verifiedBoundaries: false,
    };
  }

  private async legacy(run: RunRow) {
    return this.journal.legacyAuditEvidence(run.id);
  }

  private async historicalIdentityCoverage(source: string) {
    const [record] = await this.db.query<
      Array<{
        mapped_admins: number;
        mapped_accounts: number;
        mapped_actor_admins: number;
        unmatched_admin_pairs: number;
        unmatched_account_pairs: number;
        unmatched_actor_pairs: number;
        imported_at: Date;
      }>
    >(
      source === identitySource(source)
        ? `SELECT mapped_admins,mapped_accounts,mapped_actor_admins,
            unmatched_admin_pairs,unmatched_account_pairs,unmatched_actor_pairs,imported_at
           FROM fair_replay_private_identity_imports WHERE source_instance_id=$1`
        : `WITH aliases AS (
            SELECT DISTINCT a.role,a.id,a.name
            FROM pasarguard_events e CROSS JOIN LATERAL (VALUES
              ('billing_admin',e.billing_admin_id,e.billing_admin_username),
              ('account',e.external_user_id,e.username),
              ('actor_admin',e.actor_admin_id,e.actor_admin_username)
            ) a(role,id,name)
            WHERE e.source_instance_id=$2 AND a.id IS NOT NULL
          ), matches AS (
            SELECT a.role,a.id,m.original_id,
                   NULLIF(m.original_username,'') AS original_username
            FROM aliases a LEFT JOIN fair_replay_private_identity_aliases m
              ON m.source_instance_id=$1 AND m.role=a.role AND m.archived_id=a.id
              AND m.archived_username=COALESCE(a.name,'')
          )
          SELECT COUNT(DISTINCT id) FILTER(WHERE role='billing_admin' AND original_username IS NOT NULL)::int AS mapped_admins,
            COUNT(DISTINCT id) FILTER(WHERE role='account' AND original_id IS NOT NULL)::int AS mapped_accounts,
            COUNT(DISTINCT id) FILTER(WHERE role='actor_admin' AND original_id IS NOT NULL)::int AS mapped_actor_admins,
            COUNT(*) FILTER(WHERE role='billing_admin' AND original_username IS NULL)::int AS unmatched_admin_pairs,
            COUNT(*) FILTER(WHERE role='account' AND original_id IS NULL)::int AS unmatched_account_pairs,
            COUNT(*) FILTER(WHERE role='actor_admin' AND original_id IS NULL)::int AS unmatched_actor_pairs,
            i.imported_at
          FROM fair_replay_private_identity_imports i LEFT JOIN matches ON TRUE
          WHERE i.source_instance_id=$1 GROUP BY i.imported_at`,
      source === identitySource(source)
        ? [source]
        : [identitySource(source), source],
    );
    return record
      ? {
          status:
            record.unmatched_admin_pairs === 0
              ? 'SOURCE_VERIFIED'
              : 'PARTIAL_SOURCE_MATCH',
          mappedBillingAdmins: record.mapped_admins,
          mappedAccounts: record.mapped_accounts,
          mappedActorAdmins: record.mapped_actor_admins,
          unmatchedArchiveAdminPairs: record.unmatched_admin_pairs,
          unmatchedArchiveAccountPairs: record.unmatched_account_pairs,
          unmatchedArchiveActorPairs: record.unmatched_actor_pairs,
          importedAt: record.imported_at.toISOString(),
          currentDirectoryMatched: false,
        }
      : {
          status: 'NOT_IMPORTED',
          mappedBillingAdmins: 0,
          mappedAccounts: 0,
          mappedActorAdmins: 0,
          unmatchedArchiveAdminPairs: null,
          unmatchedArchiveAccountPairs: null,
          unmatchedArchiveActorPairs: null,
          importedAt: null,
          currentDirectoryMatched: false,
        };
  }

  private async hasSnapshot(runId: string): Promise<boolean> {
    const [r] = await this.db.query<{ present: boolean }[]>(
      `SELECT EXISTS(SELECT 1 FROM fair_replay_shadow_audit_prices WHERE run_id=$1) AS present`,
      [runId],
    );
    return r?.present === true;
  }

  async overview(runId?: string) {
    const runs = await this.runs();
    const run = await this.resolve(runId);
    const coverage = await this.coverage(run);
    const [
      days,
      lines,
      held,
      candidates,
      ignored,
      missingEvents,
      creditErrors,
    ] = await Promise.all([
      this.db.query<
        {
          ready: string;
          pending: string;
          charges: string;
          credits: string;
          net: string;
          days: string;
        }[]
      >(
        `SELECT COUNT(*)::text AS days,COUNT(*) FILTER (WHERE status='SHADOW_READY')::text AS ready,
          COUNT(*) FILTER (WHERE status='PENDING_REVIEW')::text AS pending,
          COALESCE(SUM(charge_toman),0)::text AS charges,
          COALESCE(SUM(credit_toman),0)::text AS credits,
          COALESCE(SUM(net_toman),0)::text AS net
         FROM fair_replay_shadow_days WHERE run_id=$1`,
        [run.id],
      ),
      this.db.query<
        {
          count: string;
          charges: string;
          credits: string;
          mismatchedDays: string;
        }[]
      >(
        `WITH lines AS (
           SELECT billing_admin_id,local_day,COUNT(*) AS cnt,
             COALESCE(SUM(amount_toman) FILTER(WHERE entry_type='CHARGE'),0) AS ch,
             COALESCE(SUM(amount_toman) FILTER(WHERE entry_type='CREDIT'),0) AS cr
           FROM fair_replay_shadow_entries WHERE run_id=$1 GROUP BY billing_admin_id,local_day),
         mismatches AS (
           SELECT d.billing_admin_id FROM fair_replay_shadow_days d
           LEFT JOIN lines l USING(billing_admin_id,local_day)
           WHERE d.run_id=$1 AND ((d.status='SHADOW_READY' AND
             (d.entry_count<>COALESCE(l.cnt,0) OR d.charge_toman<>COALESCE(l.ch,0)
              OR d.credit_toman<>COALESCE(l.cr,0) OR d.net_toman<>COALESCE(l.ch,0)-COALESCE(l.cr,0)))
             OR (d.status='PENDING_REVIEW' AND l.cnt IS NOT NULL)))
         SELECT (SELECT COUNT(*)::text FROM fair_replay_shadow_entries WHERE run_id=$1) AS count,
           (SELECT COALESCE(SUM(amount_toman),0)::text FROM fair_replay_shadow_entries
              WHERE run_id=$1 AND entry_type='CHARGE') AS charges,
           (SELECT COALESCE(SUM(amount_toman),0)::text FROM fair_replay_shadow_entries
              WHERE run_id=$1 AND entry_type='CREDIT') AS credits,
           (SELECT COUNT(*)::text FROM mismatches) AS "mismatchedDays"`,
        [run.id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
        FROM fair_replay_shadow_holds WHERE run_id=$1`,
        [run.id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
        FROM fair_replay_shadow_held_candidates WHERE run_id=$1`,
        [run.id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT COALESCE(SUM(event_count),0)::text AS count
        FROM fair_replay_shadow_ignored_summary WHERE run_id=$1`,
        [run.id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM fair_replay_shadow_entries e
        CROSS JOIN LATERAL unnest(e.source_event_ids) AS eid(id)
        LEFT JOIN pasarguard_events p ON p.id=eid.id AND p.source_instance_id=$2
        WHERE e.run_id=$1 AND (p.id IS NULL OR p.billing_admin_id<>e.billing_admin_id
          OR p.external_user_id<>e.external_user_id)`,
        [run.id, run.source_instance_id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count FROM fair_replay_shadow_entries e
        LEFT JOIN fair_replay_shadow_entries purchase ON
          purchase.run_id=e.run_id AND purchase.operation_key=e.reference_operation_key
          AND purchase.entry_type='CHARGE' AND purchase.billing_admin_id=e.billing_admin_id
          AND purchase.external_user_id=e.external_user_id
          AND purchase.amount_toman=e.amount_toman
        WHERE e.run_id=$1 AND e.entry_type='CREDIT' AND purchase.operation_key IS NULL`,
        [run.id],
      ),
    ]);
    const hasSnapshot = await this.hasSnapshot(run.id);
    const snapshotPrices = hasSnapshot
      ? await this.db.query<
          Array<{
            packageId: string;
            bytes: string;
            days: number;
            amountToman: string;
          }>
        >(
          `SELECT package_id::text AS "packageId",package_bytes::text AS bytes,
        duration_days AS days,amount_toman::text AS "amountToman"
        FROM fair_replay_shadow_audit_prices WHERE run_id=$1 ORDER BY package_id`,
          [run.id],
        )
      : [];
    const snapshotHash = hasSnapshot
      ? createHash('sha256')
          .update(JSON.stringify(snapshotPrices))
          .digest('hex')
      : null;
    const [priceMismatches, heldDayViolations] = await Promise.all([
      this.db.query<{ count: string }[]>(
        `SELECT COUNT(*)::text AS count
        FROM (
          SELECT e.amount_toman,e.package_id,e.run_id FROM fair_replay_shadow_entries e
          WHERE e.run_id=$1
          UNION ALL
          SELECT h.amount_toman,h.package_id,h.run_id
          FROM fair_replay_shadow_held_candidates h WHERE h.run_id=$1
        ) lines LEFT JOIN fair_replay_shadow_audit_prices p
          ON p.run_id=lines.run_id AND p.package_id=lines.package_id
        WHERE (p.package_id IS NULL OR lines.amount_toman<>p.amount_toman)`,
        [run.id],
      ),
      this.db.query<{ count: string }[]>(
        `SELECT (
        (SELECT COUNT(*) FROM fair_replay_shadow_holds h JOIN fair_replay_shadow_days d
          USING(run_id,billing_admin_id,local_day)
          WHERE h.run_id=$1 AND d.status<>'PENDING_REVIEW') +
        (SELECT COUNT(*) FROM fair_replay_shadow_held_candidates h JOIN fair_replay_shadow_days d
          USING(run_id,billing_admin_id,local_day)
          WHERE h.run_id=$1 AND d.status<>'PENDING_REVIEW') +
        (SELECT COUNT(*) FROM fair_replay_shadow_days d
          WHERE d.run_id=$1 AND d.hold_count <>
            (SELECT COUNT(*) FROM fair_replay_shadow_holds h WHERE h.run_id=d.run_id
              AND h.billing_admin_id=d.billing_admin_id AND h.local_day=d.local_day))
      )::text AS count`,
        [run.id],
      ),
    ]);
    let candidatesCount = int(candidates[0]?.count ?? '0');
    let ignoredCount = int(ignored[0]?.count ?? '0');
    let legacyError: string | null = null;
    if (!hasSnapshot) {
      try {
        const evidence = await this.legacy(run);
        candidatesCount = String(evidence.heldCandidates.length);
        ignoredCount = String(
          evidence.ignoredByAction.reduce((v, x) => v + x.count, 0),
        );
      } catch (error) {
        legacyError =
          error instanceof Error ? error.message : 'SHADOW_AUDIT_UNAVAILABLE';
      }
    }
    const stats = days[0]!;
    const entries = lines[0]!;
    const errors = [
      ...(legacyError ? [legacyError] : []),
      ...(run.event_count !== coverage.eventCount
        ? ['ARCHIVE_EVENT_COUNT_MISMATCH']
        : []),
      ...(run.entry_count !== Number(entries.count)
        ? ['ENTRY_COUNT_MISMATCH']
        : []),
      ...(run.held_count !== Number(held[0]?.count ?? 0)
        ? ['HOLD_COUNT_MISMATCH']
        : []),
      ...(run.held_candidate_count !== Number(candidatesCount)
        ? ['HELD_CANDIDATE_COUNT_MISMATCH']
        : []),
      ...(run.ignored_count !== Number(ignoredCount)
        ? ['IGNORED_COUNT_MISMATCH']
        : []),
      ...(hasSnapshot &&
      (snapshotPrices.length !== 25 || snapshotHash !== run.catalog_hash)
        ? ['FROZEN_CATALOG_INTEGRITY_ERROR']
        : []),
      ...(hasSnapshot && Number(priceMismatches[0]?.count ?? 0) > 0
        ? ['FROZEN_PRICE_MISMATCH']
        : []),
      ...(Number(heldDayViolations[0]?.count ?? 0) > 0
        ? ['BLOCKED_DAY_LINK_MISMATCH']
        : []),
      ...(stats.charges !== entries.charges ||
      stats.credits !== entries.credits ||
      BigInt(stats.charges) - BigInt(stats.credits) !== BigInt(stats.net)
        ? ['AMOUNT_MISMATCH']
        : []),
      ...(Number(entries.mismatchedDays) > 0 ? ['DAY_ENTRY_MISMATCH'] : []),
      ...(Number(missingEvents[0]?.count ?? 0) > 0
        ? ['EVENT_REFERENCE_MISMATCH']
        : []),
      ...(Number(creditErrors[0]?.count ?? 0) > 0
        ? ['CREDIT_REFERENCE_MISMATCH']
        : []),
    ];
    return {
      mode: 'HISTORICAL_SHADOW_AUDIT' as const,
      postingScope: 'SHADOW' as const,
      liveBalanceMutated: false as const,
      weekStartDay: this.weekStartDay,
      timeZone: run.time_zone,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
      run: {
        id: run.id,
        source: run.source_instance_id,
        status: run.status,
        catalogHash: run.catalog_hash,
        correlationWindowSeconds: run.correlation_window_seconds,
        deleteCreditEnabled: run.delete_credit_enabled,
        eventCount: run.event_count,
        entryCount: run.entry_count,
        heldCount: run.held_count,
        heldCandidateCount: run.held_candidate_count,
        ignoredCount: run.ignored_count,
        createdAt: run.created_at.toISOString(),
        finishedAt: run.finished_at?.toISOString() ?? null,
      },
      coverage: {
        from: coverage.from,
        to: coverage.to,
        verifiedBoundaries: coverage.verifiedBoundaries,
      },
      totals: {
        observedDays: Number(stats.days),
        readyDays: Number(stats.ready),
        pendingDays: Number(stats.pending),
        chargesToman: stats.charges,
        creditsToman: stats.credits,
        netToman: stats.net,
        heldCandidates: Number(candidatesCount),
        ignoredEvents: Number(ignoredCount),
      },
      integrity: {
        status: errors.length ? 'INTEGRITY_ERROR' : 'RECONCILED',
        errors,
        note: 'Internal journal consistency only; not independent proof of historical identity or LIVE charges.',
      },
      historicalIdentityVerified: false,
      historicalSourceIdentity: await this.historicalIdentityCoverage(
        run.source_instance_id,
      ),
    };
  }

  async admins(filters: AuditPageFilters) {
    const run = await this.resolve(filters.runId);
    const search = filters.search ?? '';
    const rows = await this.db.query<
      Array<{
        billingAdminId: string;
        names: string[] | null;
        verifiedNames: string[] | null;
        verifiedIds: string[] | null;
        unmatchedAliases: string;
        observedDays: string;
        readyDays: string;
        pendingDays: string;
        chargeToman: string;
        creditToman: string;
        netToman: string;
        holdCount: string;
        entryCount: string;
      }>
    >(
      `WITH admin_names AS (
        SELECT e.billing_admin_id,
          ARRAY_AGG(DISTINCT e.billing_admin_username ORDER BY e.billing_admin_username)
            FILTER(WHERE e.billing_admin_username<>'') AS names,
          ARRAY_AGG(DISTINCT m.original_username ORDER BY m.original_username)
            FILTER(WHERE m.original_username IS NOT NULL AND m.original_username<>'') AS "verifiedNames",
          ARRAY_AGG(DISTINCT m.original_id::text ORDER BY m.original_id::text)
            FILTER(WHERE m.original_id IS NOT NULL) AS "verifiedIds",
          COUNT(DISTINCT (e.billing_admin_id,e.billing_admin_username))
            FILTER(WHERE NULLIF(m.original_username,'') IS NULL)::text AS "unmatchedAliases"
        FROM pasarguard_events e LEFT JOIN fair_replay_private_identity_aliases m
          ON m.source_instance_id=$6 AND m.role='billing_admin'
          AND m.archived_id=e.billing_admin_id
          AND m.archived_username=COALESCE(e.billing_admin_username,'')
        WHERE e.source_instance_id=$2 GROUP BY e.billing_admin_id),
      totals AS (
        SELECT billing_admin_id,COUNT(*)::text AS "observedDays",
          COUNT(*) FILTER(WHERE status='SHADOW_READY')::text AS "readyDays",
          COUNT(*) FILTER(WHERE status='PENDING_REVIEW')::text AS "pendingDays",
          COALESCE(SUM(charge_toman),0)::text AS "chargeToman",
          COALESCE(SUM(credit_toman),0)::text AS "creditToman",
          COALESCE(SUM(net_toman),0)::text AS "netToman",
          SUM(hold_count)::text AS "holdCount",SUM(entry_count)::text AS "entryCount"
        FROM fair_replay_shadow_days WHERE run_id=$1 GROUP BY billing_admin_id)
      SELECT t.*,t.billing_admin_id::text AS "billingAdminId",
        n.names,n."verifiedNames",n."verifiedIds",n."unmatchedAliases"
      FROM totals t LEFT JOIN admin_names n USING(billing_admin_id)
      WHERE ($3::text='' OR POSITION(LOWER($3) IN LOWER(t.billing_admin_id::text))>0 OR
        EXISTS(SELECT 1 FROM unnest(n.names) name WHERE POSITION(LOWER($3) IN LOWER(name))>0) OR
        EXISTS(SELECT 1 FROM unnest(n."verifiedNames") name WHERE POSITION(LOWER($3) IN LOWER(name))>0) OR
        EXISTS(SELECT 1 FROM unnest(n."verifiedIds") id WHERE POSITION($3 IN id)>0))
      ORDER BY t.billing_admin_id LIMIT $4 OFFSET $5`,
      [
        run.id,
        run.source_instance_id,
        search,
        filters.limit + 1,
        filters.offset,
        identitySource(run.source_instance_id),
      ],
    );
    const candidatesByAdmin = new Map<string, number>();
    if (await this.hasSnapshot(run.id)) {
      const candidateCounts = await this.db.query<
        { adminId: string; count: string }[]
      >(
        `SELECT billing_admin_id::text AS "adminId",COUNT(*)::text AS count
         FROM fair_replay_shadow_held_candidates WHERE run_id=$1 GROUP BY billing_admin_id`,
        [run.id],
      );
      for (const item of candidateCounts)
        candidatesByAdmin.set(item.adminId, Number(item.count));
    } else {
      const legacy = await this.legacy(run);
      for (const item of legacy.heldCandidates)
        candidatesByAdmin.set(
          item.billingAdminId,
          (candidatesByAdmin.get(item.billingAdminId) ?? 0) + 1,
        );
    }
    return {
      runId: run.id,
      ...page(
        rows.map((r) => ({
          ...r,
          adminName:
            r.verifiedNames?.length === 1
              ? r.verifiedNames[0]
              : r.verifiedIds?.length ||
                  run.source_instance_id !==
                    identitySource(run.source_instance_id)
                ? null
                : r.names?.length === 1
                  ? r.names[0]
                  : null,
          historicalAdminId:
            r.verifiedIds?.length === 1 ? r.verifiedIds[0] : null,
          nameStatus: r.verifiedIds?.length
            ? r.verifiedNames?.length === 1
              ? Number(r.unmatchedAliases) > 0
                ? 'PARTIAL_SOURCE_MATCH'
                : 'SOURCE_VERIFIED_HISTORICAL'
              : r.verifiedNames?.length
                ? 'HISTORICAL_NAME_CONFLICT'
                : 'SOURCE_VERIFIED_ID_ONLY'
            : run.source_instance_id !== identitySource(run.source_instance_id)
              ? 'ARCHIVE_PSEUDONYMIZED'
              : archivedAdminNameStatus(r.names, 'VERIFIED_IN_ARCHIVE'),
          heldCandidateCount: candidatesByAdmin.get(r.billingAdminId) ?? 0,
          status: Number(r.pendingDays) > 0 ? 'PENDING_REVIEW' : 'RECONCILED',
        })),
        filters.limit,
        filters.offset,
      ),
    };
  }

  async periods(filters: AuditPageFilters, period: ReportPeriod) {
    if (!filters.billingAdminId) throw new RangeError('BILLING_ADMIN_REQUIRED');
    const run = await this.resolve(filters.runId);
    const archive = await this.coverage(run);
    const rows = await this.db.query<
      Array<{
        localDay: string;
        status: StoredShadowDay['status'];
        chargeToman: string | null;
        creditToman: string | null;
        netToman: string | null;
        entryCount: number;
        holdCount: number;
      }>
    >(
      `SELECT local_day AS "localDay",status,
      charge_toman::text AS "chargeToman",credit_toman::text AS "creditToman",
      net_toman::text AS "netToman",entry_count AS "entryCount",hold_count AS "holdCount"
      FROM fair_replay_shadow_days WHERE run_id=$1 AND billing_admin_id=$2
      ORDER BY local_day LIMIT 4001`,
      [run.id, filters.billingAdminId],
    );
    if (rows.length > 4000)
      throw new RangeError('SHADOW_AUDIT_DATE_RANGE_TOO_WIDE');
    const grouped = groupShadowReportDays(
      rows,
      period,
      this.weekStartDay,
      archive.from,
      archive.to,
    );
    const chosen = grouped.filter(
      (row) =>
        (!filters.from || row.endDate >= filters.from) &&
        (!filters.to || row.startDate <= filters.to),
    );
    return {
      runId: run.id,
      billingAdminId: filters.billingAdminId,
      period,
      weekStartDay: this.weekStartDay,
      timeZone: run.time_zone,
      coverage: {
        from: archive.from,
        to: archive.to,
        verifiedBoundaries: archive.verifiedBoundaries,
      },
      ...page(
        chosen.slice(filters.offset, filters.offset + filters.limit + 1),
        filters.limit,
        filters.offset,
      ),
    };
  }

  private async eventsFor(
    source: string,
    ids: string[],
    withReviewEvidence: boolean,
  ): Promise<Map<string, Record<string, unknown>>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await this.db.query<
      Array<Record<string, unknown> & { id: string }>
    >(
      `SELECT id::text,
        ${withReviewEvidence ? `${replayReviewFingerprintSql} AS fingerprint,` : ''}
        action,billing_admin_id::text AS "billingAdminId",
        billing_admin_username AS "billingAdminUsername",external_user_id::text AS "externalUserId",
        username AS "accountUsername",actor_admin_id::text AS "actorAdminId",
        actor_admin_username AS "actorAdminUsername",
        to_char(source_enqueued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceTimestamp",
        data_limit_bytes::text AS "dataLimitBytes",
        on_hold_expire_duration_seconds::text AS "durationSeconds",
        to_char(source_user_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        to_char(source_user_expire_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
        user_status AS "userStatus",event_status AS "eventStatus"
       FROM pasarguard_events WHERE source_instance_id=$1 AND id=ANY($2::bigint[])`,
      [source, unique],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async precedingContext(
    source: string,
    rows: Array<
      Pick<
        HoldRow,
        'operationKey' | 'billingAdminId' | 'externalUserId' | 'occurredAt'
      >
    >,
  ) {
    if (!rows.length) return new Map<string, Array<Record<string, unknown>>>();
    const events = await this.db.query<
      Array<Record<string, unknown> & { operationKey: string }>
    >(
      `SELECT requested.operation_key AS "operationKey",p.id::text AS id,
         p.action,p.billing_admin_id::text AS "billingAdminId",
         p.billing_admin_username AS "billingAdminUsername",
         p.external_user_id::text AS "externalUserId",p.username AS "accountUsername",
         p.actor_admin_id::text AS "actorAdminId",p.actor_admin_username AS "actorAdminUsername",
         to_char(p.source_enqueued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sourceTimestamp",
         p.data_limit_bytes::text AS "dataLimitBytes",
         p.on_hold_expire_duration_seconds::text AS "durationSeconds",
         to_char(p.source_user_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
         to_char(p.source_user_expire_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt",
         p.user_status AS "userStatus",p.event_status AS "eventStatus"
       FROM jsonb_to_recordset($1::jsonb) AS requested(
         operation_key text,billing_admin_id bigint,external_user_id bigint,before_at timestamptz)
       CROSS JOIN LATERAL (
         SELECT e.id,e.action,e.billing_admin_id,e.billing_admin_username,
           e.external_user_id,e.username,e.actor_admin_id,e.actor_admin_username,
           e.source_enqueued_at,e.data_limit_bytes,e.on_hold_expire_duration_seconds,
           e.source_user_created_at,e.source_user_expire_at,e.user_status,e.event_status
         FROM pasarguard_events e
         WHERE e.source_instance_id=$2 AND e.billing_admin_id=requested.billing_admin_id
           AND e.external_user_id=requested.external_user_id
           AND e.source_enqueued_at < requested.before_at
         ORDER BY e.source_enqueued_at DESC,e.id DESC LIMIT 3
       ) p ORDER BY requested.operation_key,p.source_enqueued_at,p.id`,
      [
        JSON.stringify(
          rows.map((r) => ({
            operation_key: r.operationKey,
            billing_admin_id: r.billingAdminId,
            external_user_id: r.externalUserId,
            before_at: r.occurredAt,
          })),
        ),
        source,
      ],
    );
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const event of events) {
      const prior = grouped.get(event.operationKey) ?? [];
      prior.push(event);
      grouped.set(event.operationKey, prior);
    }
    return grouped;
  }

  private async privateEventNames(
    source: string,
    events: Array<Record<string, unknown>>,
  ) {
    const ids = new Set<string>();
    for (const event of events)
      for (const key of ['billingAdminId', 'externalUserId', 'actorAdminId']) {
        const value = event[key];
        if (typeof value === 'string' && /^\d+$/.test(value)) ids.add(value);
      }
    const results = new Map<string, { id: string; name: string | null }>();
    if (!ids.size) return results;
    const rows = await this.db.query<
      Array<{
        role: string;
        archivedId: string;
        archivedUsername: string;
        originalId: string;
        originalUsername: string | null;
      }>
    >(
      `SELECT role,archived_id::text AS "archivedId",archived_username AS "archivedUsername",
      original_id::text AS "originalId",original_username AS "originalUsername"
      FROM fair_replay_private_identity_aliases
      WHERE source_instance_id=$1 AND archived_id=ANY($2::bigint[])`,
      [identitySource(source), [...ids]],
    );
    for (const row of rows)
      results.set(
        JSON.stringify([row.role, row.archivedId, row.archivedUsername]),
        { id: row.originalId, name: row.originalUsername },
      );
    return results;
  }

  private async decorate<
    T extends {
      eventIds: string[];
      billingAdminId: string;
      externalUserId: string;
      operationKey: string;
      occurredAt: string;
      code?: string;
    },
  >(source: string, rows: T[], includePrecedingContext = false) {
    const byId = await this.eventsFor(
      source,
      rows.flatMap((r) => r.eventIds),
      includePrecedingContext,
    );
    const context = includePrecedingContext
      ? await this.precedingContext(source, rows)
      : new Map<string, Array<Record<string, unknown>>>();
    const identities = await this.privateEventNames(source, [
      ...byId.values(),
      ...[...context.values()].flat(),
    ]);
    const verified = (
      event: Record<string, unknown>,
      role: string,
      idKey: string,
      nameKey: string,
    ) => {
      const archivedId = event[idKey];
      const alias = event[nameKey];
      if (typeof archivedId !== 'string') return null;
      return (
        identities.get(
          JSON.stringify([
            role,
            archivedId,
            typeof alias === 'string' ? alias : '',
          ]),
        ) ?? null
      );
    };
    const enriched = (
      event: Record<string, unknown>,
    ): Record<string, unknown> => {
      const admin = verified(
        event,
        'billing_admin',
        'billingAdminId',
        'billingAdminUsername',
      );
      const account = verified(
        event,
        'account',
        'externalUserId',
        'accountUsername',
      );
      const actor = verified(
        event,
        'actor_admin',
        'actorAdminId',
        'actorAdminUsername',
      );
      return {
        id: event.id,
        action: event.action,
        sourceTimestamp: event.sourceTimestamp,
        billingAdminId: event.billingAdminId,
        externalUserId: event.externalUserId,
        actorAdminId: event.actorAdminId,
        dataLimitBytes: event.dataLimitBytes,
        durationSeconds: event.durationSeconds,
        eventStatus: event.eventStatus,
        userStatus: event.userStatus,
        createdAt: event.createdAt,
        expiresAt: event.expiresAt,
        archivedBillingAdminUsername: event.billingAdminUsername,
        archivedAccountUsername: event.accountUsername,
        archivedActorAdminUsername: event.actorAdminUsername,
        billingAdminUsername: admin?.name || event.billingAdminUsername,
        accountUsername: account?.name || event.accountUsername,
        actorAdminUsername: actor?.name || event.actorAdminUsername,
        historicalBillingAdminId: admin?.id ?? null,
        historicalAccountId: account?.id ?? null,
        historicalActorId: actor?.id ?? null,
        billingAdminNameStatus: admin?.name
          ? 'SOURCE_VERIFIED_HISTORICAL'
          : 'ARCHIVE_PSEUDONYMIZED',
        accountNameStatus: account?.name
          ? 'SOURCE_VERIFIED_HISTORICAL'
          : 'ARCHIVE_PSEUDONYMIZED',
        actorNameStatus: actor?.name
          ? 'SOURCE_VERIFIED_HISTORICAL'
          : 'ARCHIVE_PSEUDONYMIZED',
      };
    };
    return rows.map((row) => {
      const sourceEvents = row.eventIds
        .map((id) => byId.get(id))
        .filter(
          (e): e is Record<string, unknown> =>
            e !== undefined &&
            e.billingAdminId === row.billingAdminId &&
            e.externalUserId === row.externalUserId,
        );
      const events = sourceEvents.map(enriched);
      const names = (field: string, evidence = events) => [
        ...new Set(
          evidence
            .map((e) => e[field])
            .filter((v): v is string => typeof v === 'string' && v !== ''),
        ),
      ];
      const verifiedAdminEvents = events.filter(
        (e) => e.billingAdminNameStatus === 'SOURCE_VERIFIED_HISTORICAL',
      );
      const verifiedAdminNames = names(
        'billingAdminUsername',
        verifiedAdminEvents,
      );
      const historicalAdminIds = names('historicalBillingAdminId');
      const adminNames = names('billingAdminUsername');
      const accountNames = names('accountUsername');
      const adminFullyMatched =
        verifiedAdminEvents.length > 0 &&
        verifiedAdminEvents.length === row.eventIds.length;
      const accountFullyMatched =
        events.length > 0 &&
        events.every(
          (e) => e.accountNameStatus === 'SOURCE_VERIFIED_HISTORICAL',
        );
      const accountPartiallyMatched = events.some(
        (e) => e.accountNameStatus === 'SOURCE_VERIFIED_HISTORICAL',
      );
      return {
        ...row,
        reviewKey:
          row.code && sourceEvents.length === row.eventIds.length
            ? replayManualReviewKey(
                row.code,
                row.billingAdminId,
                row.externalUserId,
                sourceEvents.map((e) =>
                  typeof e.fingerprint === 'string' ? e.fingerprint : undefined,
                ),
              )
            : null,
        events,
        contextEvents: (context.get(row.operationKey) ?? [])
          .filter((e) => !row.eventIds.includes(e.id as string))
          .map(enriched),
        adminName:
          verifiedAdminNames.length === 1
            ? verifiedAdminNames[0]
            : verifiedAdminNames.length === 0 &&
                source === identitySource(source) &&
                adminNames.length === 1
              ? adminNames[0]
              : null,
        historicalAdminId:
          historicalAdminIds.length === 1 ? historicalAdminIds[0] : null,
        accountName:
          accountNames.length === 1 &&
          (accountFullyMatched || !accountPartiallyMatched)
            ? accountNames[0]
            : null,
        adminNameStatus:
          verifiedAdminNames.length === 1
            ? adminFullyMatched
              ? 'SOURCE_VERIFIED_HISTORICAL'
              : 'PARTIAL_SOURCE_MATCH'
            : verifiedAdminNames.length > 1
              ? 'HISTORICAL_NAME_CONFLICT'
              : source !== identitySource(source)
                ? 'ARCHIVE_PSEUDONYMIZED'
                : archivedAdminNameStatus(adminNames, 'SOURCE'),
        accountNameStatus:
          accountFullyMatched && accountNames.length === 1
            ? 'SOURCE_VERIFIED_HISTORICAL'
            : accountFullyMatched && accountNames.length > 1
              ? 'HISTORICAL_NAME_CONFLICT'
              : accountPartiallyMatched
                ? 'PARTIAL_SOURCE_MATCH'
                : accountNames.length === 1
                  ? 'SOURCE'
                  : accountNames.length
                    ? 'CONFLICT'
                    : 'MISSING',
        eventEvidenceComplete: events.length === row.eventIds.length,
      };
    });
  }

  async entries(filters: AuditPageFilters) {
    const run = await this.resolve(filters.runId);
    const rows = await this.db.query<EntryRow[]>(
      `SELECT e.operation_key AS "operationKey",e.kind,
      (e.kind='RENEWAL' AND EXISTS (
        SELECT 1 FROM fair_replay_shadow_entries duplicate
        WHERE duplicate.run_id=e.run_id AND duplicate.operation_key<>e.operation_key
          AND duplicate.kind=e.kind AND duplicate.billing_admin_id=e.billing_admin_id
          AND duplicate.external_user_id=e.external_user_id AND duplicate.local_day=e.local_day
          AND duplicate.package_id=e.package_id AND duplicate.amount_toman=e.amount_toman
          AND duplicate.occurred_at>=date_trunc('second',e.occurred_at)
          AND duplicate.occurred_at<date_trunc('second',e.occurred_at)+interval '1 second'
      )) AS "similarRenewal",
      e.entry_type AS "entryType",e.billing_admin_id::text AS "billingAdminId",
      e.external_user_id::text AS "externalUserId",e.local_day AS "localDay",
      to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
      e.source_event_ids::text[] AS "eventIds",e.amount_toman::text AS "amountToman",
      e.package_id::text AS "packageId",e.reference_operation_key AS "referenceOperationKey",
      p.package_bytes::text AS "packageBytes",p.duration_days AS "durationDays"
      FROM fair_replay_shadow_entries e
      LEFT JOIN fair_replay_shadow_audit_prices p ON p.run_id=e.run_id AND p.package_id=e.package_id
      WHERE e.run_id=$1 AND ($2::bigint IS NULL OR e.billing_admin_id=$2)
      AND ($3::text IS NULL OR e.local_day>=$3) AND ($4::text IS NULL OR e.local_day<=$4)
      AND ($5::text IS NULL OR e.kind=$5)
      ORDER BY e.local_day,e.occurred_at,e.operation_key LIMIT $6 OFFSET $7`,
      [
        run.id,
        filters.billingAdminId ?? null,
        filters.from ?? null,
        filters.to ?? null,
        filters.kind ?? null,
        filters.limit + 1,
        filters.offset,
      ],
    );
    const displayed = rows.slice(0, filters.limit);
    const prices = await this.pricesForRun(run);
    const enriched = displayed.map((r) => ({
      ...r,
      packageBytes: r.packageBytes ?? prices.get(r.packageId)?.bytes ?? null,
      durationDays: r.durationDays ?? prices.get(r.packageId)?.days ?? null,
    }));
    return {
      runId: run.id,
      rows: await this.decorate(run.source_instance_id, enriched),
      nextOffset:
        rows.length > filters.limit ? filters.offset + filters.limit : null,
    };
  }

  private async pricesForRun(run: RunRow) {
    const rows = await this.db.query<
      { packageId: string; bytes: string; days: number }[]
    >(
      `SELECT package_id::text AS "packageId",package_bytes::text AS bytes,
        duration_days AS days FROM fair_replay_shadow_audit_prices WHERE run_id=$1`,
      [run.id],
    );
    if (rows.length) return new Map(rows.map((r) => [r.packageId, r]));
    const legacy = await this.legacy(run);
    return new Map(
      legacy.prices.map((r) => [
        r.packageId,
        { packageId: r.packageId, bytes: r.bytes, days: r.days },
      ]),
    );
  }

  async holds(filters: AuditPageFilters, approvedManual = false) {
    const run = await this.resolve(filters.runId);
    const rows = await this.db.query<HoldRow[]>(
      `SELECT operation_key AS "operationKey",reason_code AS code,
      billing_admin_id::text AS "billingAdminId",external_user_id::text AS "externalUserId",
      local_day AS "localDay",
      to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
      source_event_ids::text[] AS "eventIds"
      FROM ${approvedManual ? 'fair_replay_shadow_manual_operations' : 'fair_replay_shadow_holds'} WHERE run_id=$1
      AND ($2::bigint IS NULL OR billing_admin_id=$2)
      AND ($3::text IS NULL OR local_day>=$3) AND ($4::text IS NULL OR local_day<=$4)
      AND ($5::text IS NULL OR reason_code=$5)
      ORDER BY local_day,occurred_at,operation_key LIMIT $6 OFFSET $7`,
      [
        run.id,
        filters.billingAdminId ?? null,
        filters.from ?? null,
        filters.to ?? null,
        filters.reason ?? null,
        filters.limit + 1,
        filters.offset,
      ],
    );
    return {
      runId: run.id,
      rows: await this.decorate(
        run.source_instance_id,
        rows.slice(0, filters.limit),
        true,
      ),
      nextOffset:
        rows.length > filters.limit ? filters.offset + filters.limit : null,
    };
  }

  async candidates(filters: AuditPageFilters) {
    const run = await this.resolve(filters.runId);
    const snapshot = await this.hasSnapshot(run.id);
    let rows: EntryRow[];
    if (snapshot) {
      rows = await this.db.query<EntryRow[]>(
        `SELECT e.operation_key AS "operationKey",e.kind,
        e.entry_type AS "entryType",e.billing_admin_id::text AS "billingAdminId",
        e.external_user_id::text AS "externalUserId",e.local_day AS "localDay",
        to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
        e.source_event_ids::text[] AS "eventIds",e.amount_toman::text AS "amountToman",
        e.package_id::text AS "packageId",e.reference_operation_key AS "referenceOperationKey",
        p.package_bytes::text AS "packageBytes",p.duration_days AS "durationDays"
        FROM fair_replay_shadow_held_candidates e
        JOIN fair_replay_shadow_audit_prices p ON p.run_id=e.run_id AND p.package_id=e.package_id
        WHERE e.run_id=$1 AND ($2::bigint IS NULL OR e.billing_admin_id=$2)
        AND ($3::text IS NULL OR e.local_day>=$3) AND ($4::text IS NULL OR e.local_day<=$4)
        AND ($5::text IS NULL OR e.kind=$5)
        ORDER BY e.local_day,e.occurred_at,e.operation_key LIMIT $6 OFFSET $7`,
        [
          run.id,
          filters.billingAdminId ?? null,
          filters.from ?? null,
          filters.to ?? null,
          filters.kind ?? null,
          filters.limit + 1,
          filters.offset,
        ],
      );
    } else {
      const legacy = await this.legacy(run);
      const catalog = new Map(legacy.prices.map((p) => [p.packageId, p]));
      rows = legacy.heldCandidates
        .filter(
          (e) =>
            (!filters.billingAdminId ||
              e.billingAdminId === filters.billingAdminId) &&
            (!filters.from || e.localDay >= filters.from) &&
            (!filters.to || e.localDay <= filters.to) &&
            (!filters.kind || e.kind === filters.kind),
        )
        .sort(
          (a, b) =>
            a.localDay.localeCompare(b.localDay) ||
            a.occurredAt.localeCompare(b.occurredAt) ||
            a.operationKey.localeCompare(b.operationKey),
        )
        .slice(filters.offset, filters.offset + filters.limit + 1)
        .map((e: ReplayLedgerLine) => ({
          ...e,
          eventIds: e.eventIds,
          packageBytes: catalog.get(e.packageId)?.bytes ?? null,
          durationDays: catalog.get(e.packageId)?.days ?? null,
        }));
    }
    return {
      runId: run.id,
      bookingStatus: 'NOT_BOOKED' as const,
      rows: await this.decorate(
        run.source_instance_id,
        rows.slice(0, filters.limit),
      ),
      nextOffset:
        rows.length > filters.limit ? filters.offset + filters.limit : null,
    };
  }

  async ignored(filters: AuditPageFilters) {
    const run = await this.resolve(filters.runId);
    let rows = await this.db.query<
      { action: string; reason: string; count: number }[]
    >(
      `SELECT action,reason,event_count AS count FROM fair_replay_shadow_ignored_summary
       WHERE run_id=$1 ORDER BY event_count DESC,action,reason`,
      [run.id],
    );
    if (!(await this.hasSnapshot(run.id)))
      rows = (await this.legacy(run)).ignoredByAction;
    const filtered = rows.filter(
      (r) =>
        !filters.search ||
        r.action.includes(filters.search) ||
        r.reason.includes(filters.search),
    );
    return {
      runId: run.id,
      totalIgnored: run.ignored_count,
      ...page(
        filtered.slice(filters.offset, filters.offset + filters.limit + 1),
        filters.limit,
        filters.offset,
      ),
    };
  }
}

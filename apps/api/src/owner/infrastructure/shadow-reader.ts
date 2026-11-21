import type { DataSource } from 'typeorm';
import {
  evaluateReplayStaticCatalog,
  type PreviewAssignment,
  type PreviewActionAggregate,
  type PreviewCreateAggregate,
  type PreviewIngestion,
  type PreviewMembership,
  type PreviewPackage,
} from './replay-preview.js';

export interface ShadowFilter {
  source: string | null;
  admin: string | null;
  reason: string | null;
  date: string | null;
  limit: number;
  offset: number;
}

/** Owner-only projections; never expose usernames, raw JSON, or authentication data. */
export class PostgresShadowReader {
  constructor(
    private readonly db: DataSource,
    private readonly timeZone: string = 'Asia/Tehran',
  ) {}

  /** Explicit Owner-only, read-only historical pricing experiment. */
  async replayPreview() {
    // Replayed webhook events use a segregated source. Pricing and group
    // membership are configured on the actual PasarGuard source, `primary`.
    const source = 'replay-30d';
    const catalogSource = 'primary';
    const [
      packages,
      memberships,
      assignments,
      ingestionRows,
      actions,
      creates,
    ] = await Promise.all([
      this.db.query<PreviewPackage[]>(
        `SELECT id::text,package_bytes::text AS "packageBytes",
             duration_days AS "durationDays",amount_toman::text AS "amountToman"
           FROM fair_atomic_packages WHERE source_instance_id=$1 ORDER BY id LIMIT 501`,
        [catalogSource],
      ),
      this.db.query<PreviewMembership[]>(
        `SELECT billing_admin_id::text AS "billingAdminId",group_id::text AS "groupId"
           FROM fair_admin_group_memberships WHERE source_instance_id=$1
           ORDER BY billing_admin_id LIMIT 2001`,
        [catalogSource],
      ),
      this.db.query<PreviewAssignment[]>(
        `SELECT id::text,target_kind AS "targetKind",group_id::text AS "groupId",
             billing_admin_id::text AS "billingAdminId",package_id::text AS "packageId",
             rate_toman_per_gib::text AS "rateTomanPerGiB"
           FROM fair_tariff_assignments WHERE source_instance_id=$1 ORDER BY id LIMIT 501`,
        [catalogSource],
      ),
      this.db.query<PreviewIngestion[]>(
        `SELECT COUNT(*)::text AS "batchCount",
             COALESCE(SUM(event_count),0)::text AS "childCount",
             COUNT(*) FILTER (WHERE processing_status <> 'NORMALIZED')::text AS "unfinishedBatches"
           FROM pasarguard_webhook_batches WHERE source_instance_id=$1`,
        [source],
      ),
      this.db.query<PreviewActionAggregate[]>(
        `SELECT action,COUNT(*)::integer AS "eventCount"
           FROM pasarguard_events WHERE source_instance_id=$1
           GROUP BY action ORDER BY action LIMIT 101`,
        [source],
      ),
      this.db.query<PreviewCreateAggregate[]>(
        `WITH corrected AS (
             SELECT username,(source_enqueued_at AT TIME ZONE $2::text)::date AS local_day
             FROM pasarguard_events
             WHERE source_instance_id=$1 AND action IN ('user_created','user_deleted')
             GROUP BY username,local_day HAVING COUNT(*)>1
           )
           SELECT e.billing_admin_id::text AS "billingAdminId",
             e.data_limit_bytes::text AS "dataLimitBytes",
             e.on_hold_expire_duration_seconds::text AS "onHoldDurationSeconds",
             e.event_status AS "eventStatus",
             (corrected.username IS NOT NULL) AS "isCorrection",
             COUNT(*)::integer AS "eventCount"
           FROM pasarguard_events e
           LEFT JOIN corrected ON corrected.username=e.username AND
             corrected.local_day=(e.source_enqueued_at AT TIME ZONE $2::text)::date
           WHERE e.source_instance_id=$1 AND e.action='user_created'
           GROUP BY e.billing_admin_id,e.data_limit_bytes,e.on_hold_expire_duration_seconds,
             e.event_status,(corrected.username IS NOT NULL)
           LIMIT 70001`,
        [source, this.timeZone],
      ),
    ]);
    if (
      creates.length > 70000 ||
      actions.length > 100 ||
      packages.length > 500 ||
      memberships.length > 2000 ||
      assignments.length > 500
    )
      throw new Error('REPLAY_PREVIEW_BOUNDS_EXCEEDED');
    return evaluateReplayStaticCatalog(
      packages,
      memberships,
      assignments,
      creates,
      actions,
      this.timeZone,
      ingestionRows[0] ?? {
        batchCount: '0',
        childCount: '0',
        unfinishedBatches: '0',
      },
    );
  }

  async summary(source: string | null) {
    const [row] = await this.db.query<
      {
        closedDays: string;
        pendingDays: string;
        ambiguityCount: string;
        chargeCount: string;
      }[]
    >(
      `SELECT COUNT(*)::text AS "closedDays",
        COUNT(*) FILTER(WHERE status='PENDING_REVIEW')::text AS "pendingDays",
        COALESCE(SUM(ambiguity_count),0)::text AS "ambiguityCount",
        COALESCE(SUM(create_count-ambiguity_count),0)::text AS "chargeCount"
       FROM fair_shadow_days WHERE ($1::text IS NULL OR source_instance_id=$1)`,
      [source],
    );
    const [late] = await this.db.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM fair_shadow_late_events
       WHERE ($1::text IS NULL OR source_instance_id=$1)`,
      [source],
    );
    return {
      ...row,
      lateCount: late?.count ?? '0',
      mode: 'SHADOW_ONLY',
      financeReportsSent: false,
    };
  }

  async ambiguities(filter: ShadowFilter) {
    const rows = await this.db.query<
      {
        eventId: string;
        code: string;
        sourceInstanceId: string;
        billingAdminId: string;
        localDay: string;
        dataLimitBytes: string;
        durationDays: number | null;
        sourceTimestamp: Date;
        detectedAt: Date;
      }[]
    >(
      `WITH cases AS (
         SELECT i.event_id,i.reason_code,i.source_instance_id,i.billing_admin_id,
           i.local_day,i.data_limit_bytes,i.duration_days,i.source_enqueued_at,
           i.recorded_at AS detected_at
         FROM fair_shadow_items i WHERE i.reason_code IS NOT NULL
         UNION ALL
         SELECT l.event_id,l.reason_code,l.source_instance_id,l.billing_admin_id,
           l.local_day,e.data_limit_bytes,
           CASE WHEN e.on_hold_expire_duration_seconds BETWEEN 1 AND 3153600000
             AND mod(e.on_hold_expire_duration_seconds,86400)=0
             THEN (e.on_hold_expire_duration_seconds / 86400)::integer ELSE NULL END,
           e.source_enqueued_at,l.discovered_at
         FROM fair_shadow_late_events l JOIN pasarguard_events e ON e.id=l.event_id
       )
       SELECT event_id::text AS "eventId", reason_code AS code,
         source_instance_id AS "sourceInstanceId", billing_admin_id::text AS "billingAdminId",
         local_day AS "localDay",data_limit_bytes::text AS "dataLimitBytes",
         duration_days AS "durationDays",source_enqueued_at AS "sourceTimestamp",
         detected_at AS "detectedAt"
       FROM cases
       WHERE ($1::text IS NULL OR source_instance_id=$1)
         AND ($2::bigint IS NULL OR billing_admin_id=$2)
         AND ($3::text IS NULL OR reason_code=$3)
         AND ($4::text IS NULL OR local_day=$4)
       ORDER BY detected_at DESC,event_id DESC LIMIT $5 OFFSET $6`,
      [
        filter.source,
        filter.admin,
        filter.reason,
        filter.date,
        filter.limit + 1,
        filter.offset,
      ],
    );
    return {
      rows: rows.slice(0, filter.limit),
      nextOffset:
        rows.length > filter.limit ? filter.offset + filter.limit : null,
    };
  }
}

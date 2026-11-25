import { localJalaliDate } from '@fair-platform/calendar';
import {
  shadowPeriodBounds,
  type ReportPeriod,
  type ReportWeekStart,
} from '../application/shadow-report-periods.js';
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
import {
  evaluateReplayUpdateResetPreview,
  type PreviewOperationAggregate,
} from './replay-update-reset-preview.js';

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
    private readonly correlationWindowSeconds: number = 600,
    private readonly weekStart: ReportWeekStart = 'SATURDAY',
  ) {
    if (
      !Number.isInteger(correlationWindowSeconds) ||
      correlationWindowSeconds < 1 ||
      correlationWindowSeconds > 600
    )
      throw new RangeError('INVALID_CORRELATION_WINDOW');
  }

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
           ), create_shapes AS (
             SELECT e.billing_admin_id,e.data_limit_bytes,
               e.on_hold_expire_duration_seconds,e.event_status,
               (corrected.username IS NOT NULL) AS is_correction,
               (e.user_status='active'
                 AND e.data_limit_bytes=536870912
                 AND e.on_hold_expire_duration_seconds IS NULL
                 AND e.source_user_created_at IS NOT NULL
                 AND e.source_user_expire_at IS NOT NULL
                 AND e.source_enqueued_at-e.source_user_created_at
                   BETWEEN INTERVAL '0 seconds' AND INTERVAL '1 second'
                 AND EXTRACT(EPOCH FROM
                   (e.source_user_expire_at-e.source_user_created_at))
                   BETWEEN 172799 AND 172801
               ) AS active_two_day_date_candidate
             FROM pasarguard_events e
             LEFT JOIN corrected ON corrected.username=e.username AND
               corrected.local_day=(e.source_enqueued_at AT TIME ZONE $2::text)::date
             WHERE e.source_instance_id=$1 AND e.action='user_created'
           )
           SELECT billing_admin_id::text AS "billingAdminId",
             data_limit_bytes::text AS "dataLimitBytes",
             on_hold_expire_duration_seconds::text AS "onHoldDurationSeconds",
             event_status AS "eventStatus",is_correction AS "isCorrection",
             active_two_day_date_candidate AS "activeTwoDayDateCandidate",
             COUNT(*)::integer AS "eventCount"
           FROM create_shapes
           GROUP BY billing_admin_id,data_limit_bytes,on_hold_expire_duration_seconds,
             event_status,is_correction,active_two_day_date_candidate
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

  /**
   * Owner-only FP-006/007 aggregate-only replay. No source identities or
   * individual historical events are returned from SQL, and no writes occur.
   */
  async replayUpdateResetPreview() {
    const source = 'replay-30d';
    const [createPreview, operationGroups] = await Promise.all([
      this.replayPreview(),
      this.db.query<PreviewOperationAggregate[]>(
        `WITH timeline AS MATERIALIZED (
           SELECT e.id,e.action,e.billing_admin_id,e.external_user_id,
             e.source_enqueued_at,
             (e.source_enqueued_at AT TIME ZONE $3::text)::date AS local_day,
             e.data_limit_bytes,
             e.on_hold_expire_duration_seconds,e.event_status,
             LAG(e.id) OVER prev AS previous_event_id,
             LAG(e.action) OVER prev AS previous_action,
             LAG(e.data_limit_bytes) OVER prev AS previous_bytes,
             LAG(e.on_hold_expire_duration_seconds) OVER prev AS previous_duration,
             LAG(e.event_status) OVER prev AS previous_event_status,
             LAG(e.source_enqueued_at) OVER prev AS previous_at
           FROM pasarguard_events e
           WHERE e.source_instance_id=$1
           WINDOW prev AS (PARTITION BY e.billing_admin_id,e.external_user_id
             ORDER BY e.source_enqueued_at,e.id)
         ), cycle_starts AS MATERIALIZED (
           -- Only consecutive source-timeline Update/Reset actions can form
           -- one chain; other actions, a local-day change, ties and gaps
           -- beyond the Owner window terminate it. HTTP delivery is irrelevant.
           SELECT *,CASE WHEN previous_action IN ('user_updated','data_usage_reset')
             AND previous_at<source_enqueued_at
             AND local_day=(previous_at AT TIME ZONE $3::text)::date
             AND source_enqueued_at-previous_at <=
               ($2::integer*INTERVAL '1 second')
             THEN 0 ELSE 1 END AS cycle_start
           FROM timeline WHERE action IN ('user_updated','data_usage_reset')
         ), cycle_indices AS MATERIALIZED (
           SELECT *,SUM(cycle_start) OVER (
             PARTITION BY billing_admin_id,external_user_id
             ORDER BY source_enqueued_at,id ROWS UNBOUNDED PRECEDING
           ) AS cycle_id FROM cycle_starts
         ), cycle_members AS MATERIALIZED (
           SELECT *,
             ROW_NUMBER() OVER cycle AS cycle_position,
             COUNT(*) OVER cycle AS cycle_size,
             BOOL_AND(cycle_start=1 OR action<>previous_action)
               OVER cycle AS alternating,
             COUNT(*) FILTER (WHERE action='data_usage_reset') OVER (
               PARTITION BY billing_admin_id,external_user_id,local_day
             ) AS same_day_resets,
             COUNT(*) FILTER (WHERE action='user_updated') OVER (
               PARTITION BY billing_admin_id,external_user_id,local_day
             ) AS same_day_updates
           FROM cycle_indices
           WINDOW cycle AS (PARTITION BY billing_admin_id,external_user_id,cycle_id
             ORDER BY source_enqueued_at,id
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
         ), cycle_pairs AS MATERIALIZED (
           -- An even, fully alternating chain has one non-overlapping
           -- complete adjacent pairing: (1,2), (3,4), etc. Odd, tied or
           -- non-alternating chains stay unresolved; never pair by proximity.
           SELECT CASE WHEN a.action='user_updated' THEN a.id ELSE b.id END AS update_id,
             CASE WHEN a.action='data_usage_reset' THEN a.id ELSE b.id END AS reset_id,
             (a.cycle_size>2) AS multi_cycle_pair
           FROM cycle_members a JOIN cycle_members b
             ON b.billing_admin_id=a.billing_admin_id
             AND b.external_user_id=a.external_user_id
             AND b.cycle_id=a.cycle_id
             AND b.cycle_position=a.cycle_position+1
           WHERE a.cycle_position%2=1 AND a.cycle_size%2=0
             AND a.alternating AND b.alternating
         ), updates AS MATERIALIZED (
           SELECT * FROM timeline WHERE action='user_updated'
         ), resets AS MATERIALIZED (
           SELECT * FROM timeline WHERE action='data_usage_reset'
         ), pairs AS MATERIALIZED (
           SELECT cp.update_id,cp.reset_id,cp.multi_cycle_pair,
             (u.previous_bytes IS NOT NULL AND r.previous_bytes IS NOT NULL
               AND u.previous_bytes=u.data_limit_bytes
               AND r.previous_bytes=r.data_limit_bytes) AS generic_zero_delta,
             (u.data_limit_bytes=r.data_limit_bytes) AS same_package,
             (r.previous_event_id IS NULL
               AND u.previous_event_id=r.id
               AND r.source_enqueued_at<u.source_enqueued_at
               AND u.previous_bytes=r.data_limit_bytes)
               AS boundary_first_reset_pair,
             COALESCE((r.source_enqueued_at<u.source_enqueued_at
               AND u.previous_event_id=r.id
               AND r.previous_at<r.source_enqueued_at
               AND r.previous_event_status='READY_FOR_ACCOUNTING'
               AND r.previous_bytes=r.data_limit_bytes
               AND r.previous_duration=r.on_hold_expire_duration_seconds
               AND r.on_hold_expire_duration_seconds IS NOT NULL
               AND u.on_hold_expire_duration_seconds IS NOT NULL
               AND r.on_hold_expire_duration_seconds<>u.on_hold_expire_duration_seconds
               AND r.data_limit_bytes=u.data_limit_bytes),false) AS proven_duration_change
           FROM cycle_pairs cp JOIN updates u ON u.id=cp.update_id
             JOIN resets r ON r.id=cp.reset_id
           WHERE ((u.previous_bytes IS NOT NULL AND r.previous_bytes IS NOT NULL
                  AND (NOT (u.previous_bytes=u.data_limit_bytes AND
                     r.previous_bytes=r.data_limit_bytes)
                    OR u.data_limit_bytes=r.data_limit_bytes))
             OR (r.previous_event_id IS NULL AND u.previous_event_id=r.id
                AND r.source_enqueued_at<u.source_enqueued_at
                AND u.previous_bytes=r.data_limit_bytes))
         ), operation_rows AS (
           SELECT (CASE WHEN (p.generic_zero_delta
                 OR (p.boundary_first_reset_pair AND p.same_package))
                 AND NOT p.proven_duration_change
               THEN 'RESET_WITH_UPDATE_CONTEXT' ELSE 'RENEWAL' END)::text AS kind,
             (CASE WHEN (p.generic_zero_delta
                   OR (p.boundary_first_reset_pair AND p.same_package))
                   AND NOT p.proven_duration_change
               THEN r.data_limit_bytes
               WHEN r.source_enqueued_at>u.source_enqueued_at
               THEN r.data_limit_bytes ELSE u.data_limit_bytes END) AS bytes,
             NULL::numeric AS previous_bytes,
             (CASE WHEN (p.generic_zero_delta
                   OR (p.boundary_first_reset_pair AND p.same_package))
                   AND NOT p.proven_duration_change THEN
                 COALESCE(r.on_hold_expire_duration_seconds,
                   u.on_hold_expire_duration_seconds)
               WHEN r.source_enqueued_at>u.source_enqueued_at
               THEN r.on_hold_expire_duration_seconds
               ELSE u.on_hold_expire_duration_seconds END) AS duration,
             u.event_status,r.event_status AS counterpart_status,
             NULL::text AS previous_event_status,
             (r.source_enqueued_at<>u.source_enqueued_at) AS ordered_previous,
             false AS ambiguous_counterpart,
             p.same_package AND NOT p.proven_duration_change AND
               r.on_hold_expire_duration_seconds IS NOT NULL AND
               u.on_hold_expire_duration_seconds IS NOT NULL AND
               r.on_hold_expire_duration_seconds<>
                 u.on_hold_expire_duration_seconds AS duration_conflict,
             p.boundary_first_reset_pair AS boundary_first_pair
             ,p.proven_duration_change AS proven_duration_change
             ,p.multi_cycle_pair AS multi_cycle_pair
           FROM pairs p JOIN updates u ON u.id=p.update_id
             JOIN resets r ON r.id=p.reset_id
           UNION ALL
           SELECT 'UPDATE_ONLY',u.data_limit_bytes,u.previous_bytes,
             u.on_hold_expire_duration_seconds,u.event_status,NULL::text,
             u.previous_event_status,
             COALESCE(u.previous_at<u.source_enqueued_at,false),
             (u.same_day_resets>0),
             false,false,false,false
           FROM cycle_members u WHERE u.action='user_updated' AND NOT EXISTS
             (SELECT 1 FROM pairs p WHERE p.update_id=u.id)
           UNION ALL
           SELECT 'RESET_ONLY',r.data_limit_bytes,NULL::numeric,
             r.on_hold_expire_duration_seconds,r.event_status,NULL::text,
             NULL::text,false,
             (r.same_day_updates>0),
             false,false,false,false
           FROM cycle_members r WHERE r.action='data_usage_reset' AND NOT EXISTS
             (SELECT 1 FROM pairs p WHERE p.reset_id=r.id)
         )
         SELECT kind,data_limit_bytes::text AS "dataLimitBytes",
           previous_bytes::text AS "previousBytes",
           duration::text AS "onHoldDurationSeconds",
           event_status AS "eventStatus",
           counterpart_status AS "counterpartStatus",
           previous_event_status AS "previousEventStatus",
           ordered_previous AS "orderedPrevious",
           ambiguous_counterpart AS "ambiguousCounterpart",
           duration_conflict AS "durationConflict",
           boundary_first_pair AS "boundaryFirstPair",
           proven_duration_change AS "provenDurationChange",
           multi_cycle_pair AS "multiCyclePair",
           COUNT(*)::integer AS "eventCount"
         FROM (SELECT kind,bytes AS data_limit_bytes,previous_bytes,
           duration,event_status,counterpart_status,previous_event_status,
           ordered_previous,ambiguous_counterpart,duration_conflict,
           boundary_first_pair,proven_duration_change,multi_cycle_pair
           FROM operation_rows) grouped
         GROUP BY kind,data_limit_bytes,previous_bytes,duration,event_status,
           counterpart_status,previous_event_status,ordered_previous,
           ambiguous_counterpart,duration_conflict,boundary_first_pair,
           proven_duration_change,multi_cycle_pair
         LIMIT 70001`,
        [source, this.correlationWindowSeconds, this.timeZone],
      ),
    ]);
    if (operationGroups.length > 70000)
      throw new Error('REPLAY_PREVIEW_BOUNDS_EXCEEDED');
    return evaluateReplayUpdateResetPreview(
      createPreview,
      operationGroups,
      this.correlationWindowSeconds,
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
        COUNT(*) FILTER(WHERE pending>0)::text AS "pendingDays",
        COALESCE(SUM(pending),0)::text AS "ambiguityCount",
        (SELECT count(*) FROM fair_shadow_items i WHERE amount_toman IS NOT NULL AND ($1::text IS NULL OR i.source_instance_id=$1)) + (SELECT count(*) FROM fair_shadow_reviews r JOIN fair_shadow_days d ON d.id=r.day_id WHERE r.package_id IS NOT NULL AND ($1::text IS NULL OR d.source_instance_id=$1)) AS "chargeCount"
       FROM fair_shadow_day_reports WHERE ($1::text IS NULL OR source=$1)`,
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

  async review(id: string, eventIds: string[], packageId: string | null) {
    const ids = [...new Set(eventIds)].sort();
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('fair-shadow-review',0))",
      );
      const existing = await tx.query<
        { eventIds: string[]; packageId: string | null }[]
      >(
        `SELECT r.package_id::text AS "packageId", array_agg(e.event_id::text) AS "eventIds"
         FROM fair_shadow_reviews r JOIN fair_shadow_review_events e ON e.review_id=r.id
         WHERE r.id=$1 GROUP BY r.id`,
        [id],
      );
      if (existing[0])
        return (
          existing[0].packageId === packageId &&
          JSON.stringify(existing[0].eventIds.sort()) === JSON.stringify(ids)
        );
      const [result] = await tx.query<{ id: string }[]>(
        `WITH eligible AS (
           SELECT day_id,event_id,source_instance_id FROM fair_shadow_items WHERE reason_code IS NOT NULL AND reason_code NOT IN ('RENEWAL_EVIDENCE','UNCHANGED_OR_DECREASED')
           UNION ALL SELECT day_id,event_id,source_instance_id FROM fair_shadow_late_events
         ), chosen AS (
           SELECT min(c.day_id) AS day_id,min(c.source_instance_id) AS source
           FROM eligible c JOIN pasarguard_events e ON e.id=c.event_id
           WHERE c.event_id=ANY($2::bigint[]) AND NOT EXISTS
             (SELECT FROM fair_shadow_review_events v WHERE v.event_id=c.event_id)
           HAVING count(*)=cardinality($2::bigint[]) AND count(DISTINCT c.day_id)=1
             AND count(DISTINCT e.external_user_id)=1
         )
         INSERT INTO fair_shadow_reviews(id,day_id,package_id,amount_toman,package_bytes)
         SELECT $1,c.day_id,p.id,coalesce(p.amount_toman,0),coalesce(p.package_bytes,0)
         FROM chosen c LEFT JOIN fair_atomic_packages p ON p.id=$3 AND p.source_instance_id=c.source
         WHERE $3::bigint IS NULL OR p.id IS NOT NULL RETURNING id`,
        [id, ids, packageId],
      );
      if (!result) return false;
      await tx.query(
        `INSERT INTO fair_shadow_review_events(review_id,event_id)
        SELECT $1,unnest($2::bigint[])`,
        [id, ids],
      );
      return true;
    });
  }

  async dayReports(filter: ShadowFilter, period: ReportPeriod = 'day') {
    const date = filter.date || localJalaliDate(new Date(), this.timeZone);
    const bounds = shadowPeriodBounds(date, period, this.weekStart);
    if (period !== 'day')
      return this.db.query<
        {
          source: string;
          admin: string;
          day: string;
          amountToman: string;
          soldBytes: string;
          pending: number;
        }[]
      >(
        `SELECT source,admin,$3::text || ' — ' || $4::text AS day,sum(amount_toman)::text AS "amountToman",
       sum(sold_bytes)::text AS "soldBytes",sum(sum(amount_toman)) OVER ()::text AS "periodAmountToman",sum(sum(sold_bytes)) OVER ()::text AS "periodSoldBytes",sum(pending)::integer AS pending FROM fair_shadow_day_reports
       WHERE ($1::text IS NULL OR source=$1) AND ($2::text IS NULL OR admin=$2) AND day BETWEEN $3 AND $4
       GROUP BY source,admin ORDER BY source,admin LIMIT $5 OFFSET $6`,
        [
          filter.source,
          filter.admin,
          bounds.start,
          bounds.end,
          filter.limit,
          filter.offset,
        ],
      );
    return this.db.query<
      {
        source: string;
        admin: string;
        day: string;
        amountToman: string;
        soldBytes: string;
        pending: number;
      }[]
    >(
      `SELECT source,admin,day,amount_toman::text AS "amountToman",sold_bytes::text AS "soldBytes",sum(amount_toman) OVER (PARTITION BY day)::text AS "periodAmountToman",sum(sold_bytes) OVER (PARTITION BY day)::text AS "periodSoldBytes",pending
       FROM fair_shadow_day_reports WHERE ($1::text IS NULL OR source=$1)
       AND ($2::text IS NULL OR admin=$2) AND ($3::text IS NULL OR day=$3)
       ORDER BY day DESC,day_id DESC LIMIT $4 OFFSET $5`,
      [filter.source, filter.admin, filter.date, filter.limit, filter.offset],
    );
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
         FROM fair_shadow_items i WHERE i.reason_code IS NOT NULL AND i.reason_code NOT IN ('RENEWAL_EVIDENCE','UNCHANGED_OR_DECREASED')
         UNION ALL
         SELECT l.event_id,l.reason_code,l.source_instance_id,l.billing_admin_id,
           l.local_day,e.data_limit_bytes,
           CASE WHEN e.on_hold_expire_duration_seconds BETWEEN 1 AND 3153600000
             AND mod(e.on_hold_expire_duration_seconds,86400)=0
             THEN (e.on_hold_expire_duration_seconds / 86400)::integer ELSE NULL END,
           e.source_enqueued_at,l.discovered_at
         FROM fair_shadow_late_events l JOIN pasarguard_events e ON e.id=l.event_id
       )
       SELECT event_id::text AS "eventId", (SELECT external_user_id::text FROM pasarguard_events WHERE id=cases.event_id) AS "accountId",
         (SELECT action FROM pasarguard_events WHERE id=cases.event_id) AS action, reason_code AS code,
         source_instance_id AS "sourceInstanceId", billing_admin_id::text AS "billingAdminId",
         local_day AS "localDay",data_limit_bytes::text AS "dataLimitBytes",
         duration_days AS "durationDays",source_enqueued_at AS "sourceTimestamp",
         detected_at AS "detectedAt"
       FROM cases
       WHERE NOT EXISTS (SELECT FROM fair_shadow_review_events v WHERE v.event_id=cases.event_id)
         AND ($1::text IS NULL OR source_instance_id=$1)
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

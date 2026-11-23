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
    private readonly correlationWindowSeconds: number = 120,
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
             e.source_enqueued_at,e.data_limit_bytes,
             e.on_hold_expire_duration_seconds,e.event_status,
             LAG(e.id) OVER prev AS previous_event_id,
             LAG(e.data_limit_bytes) OVER prev AS previous_bytes,
             LAG(e.event_status) OVER prev AS previous_event_status,
             LAG(e.source_enqueued_at) OVER prev AS previous_at
           FROM pasarguard_events e
           WHERE e.source_instance_id=$1
           WINDOW prev AS (PARTITION BY e.billing_admin_id,e.external_user_id
             ORDER BY e.source_enqueued_at,e.id)
         ), updates AS MATERIALIZED (
           SELECT * FROM timeline WHERE action='user_updated'
         ), resets AS MATERIALIZED (
           SELECT * FROM timeline WHERE action='data_usage_reset'
         ), candidate_edges AS MATERIALIZED (
           SELECT u.id AS update_id,r.id AS reset_id,
             (u.previous_bytes IS NOT NULL AND r.previous_bytes IS NOT NULL
               AND u.previous_bytes=u.data_limit_bytes
               AND r.previous_bytes=r.data_limit_bytes) AS generic_zero_delta,
             (u.data_limit_bytes=r.data_limit_bytes) AS same_package,
             (u.previous_bytes IS NOT NULL AND r.previous_bytes IS NOT NULL)
               AS prior_state_known,
             (r.previous_event_id IS NULL
               AND u.previous_event_id=r.id
               AND r.source_enqueued_at<u.source_enqueued_at
               AND u.previous_bytes=r.data_limit_bytes)
               AS boundary_first_reset_pair
           FROM updates u JOIN resets r
             ON r.billing_admin_id=u.billing_admin_id
             AND r.external_user_id=u.external_user_id
             AND r.source_enqueued_at BETWEEN
               u.source_enqueued_at-($2::integer*INTERVAL '1 second') AND
               u.source_enqueued_at+($2::integer*INTERVAL '1 second')
         ), edge_counts AS (
           SELECT update_id,reset_id,
             COUNT(*) OVER (PARTITION BY update_id) AS resets_for_update,
             COUNT(*) OVER (PARTITION BY reset_id) AS updates_for_reset,
             prior_state_known,generic_zero_delta,same_package,
             boundary_first_reset_pair
           FROM candidate_edges
         ), pairs AS MATERIALIZED (
           -- Only mutually unique candidates may pair. A zero-delta Update
           -- proves no package change, but can corroborate Reset duration
           -- when its source snapshot has the exact same package bytes.
           SELECT update_id,reset_id,generic_zero_delta,
             boundary_first_reset_pair,same_package FROM edge_counts
           WHERE resets_for_update=1 AND updates_for_reset=1
             AND ((prior_state_known
                 AND (NOT generic_zero_delta OR same_package))
               OR boundary_first_reset_pair)
         ), operation_rows AS (
           SELECT (CASE WHEN p.generic_zero_delta
                 OR (p.boundary_first_reset_pair AND p.same_package)
               THEN 'RESET_WITH_UPDATE_CONTEXT' ELSE 'RENEWAL' END)::text AS kind,
             (CASE WHEN p.generic_zero_delta
                   OR (p.boundary_first_reset_pair AND p.same_package)
               THEN r.data_limit_bytes
               WHEN r.source_enqueued_at>u.source_enqueued_at
               THEN r.data_limit_bytes ELSE u.data_limit_bytes END) AS bytes,
             NULL::numeric AS previous_bytes,
             (CASE WHEN p.generic_zero_delta
                   OR (p.boundary_first_reset_pair AND p.same_package) THEN
                 COALESCE(r.on_hold_expire_duration_seconds,
                   u.on_hold_expire_duration_seconds)
               WHEN r.source_enqueued_at>u.source_enqueued_at
               THEN r.on_hold_expire_duration_seconds
               ELSE u.on_hold_expire_duration_seconds END) AS duration,
             u.event_status,r.event_status AS counterpart_status,
             NULL::text AS previous_event_status,
             (r.source_enqueued_at<>u.source_enqueued_at) AS ordered_previous,
             false AS ambiguous_counterpart,
             (p.generic_zero_delta OR
               (p.boundary_first_reset_pair AND p.same_package)) AND
               r.on_hold_expire_duration_seconds IS NOT NULL AND
               u.on_hold_expire_duration_seconds IS NOT NULL AND
               r.on_hold_expire_duration_seconds<>
                 u.on_hold_expire_duration_seconds AS duration_conflict,
             p.boundary_first_reset_pair AS boundary_first_pair
           FROM pairs p JOIN updates u ON u.id=p.update_id
             JOIN resets r ON r.id=p.reset_id
           UNION ALL
           SELECT 'UPDATE_ONLY',u.data_limit_bytes,u.previous_bytes,
             u.on_hold_expire_duration_seconds,u.event_status,NULL::text,
             u.previous_event_status,
             COALESCE(u.previous_at<u.source_enqueued_at,false),
             EXISTS(SELECT 1 FROM candidate_edges e WHERE e.update_id=u.id),
             false,false
           FROM updates u WHERE NOT EXISTS
             (SELECT 1 FROM pairs p WHERE p.update_id=u.id)
           UNION ALL
           SELECT 'RESET_ONLY',r.data_limit_bytes,NULL::numeric,
             r.on_hold_expire_duration_seconds,r.event_status,NULL::text,
             NULL::text,false,
             EXISTS(SELECT 1 FROM candidate_edges e WHERE e.reset_id=r.id),
             false,false
           FROM resets r WHERE NOT EXISTS
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
           COUNT(*)::integer AS "eventCount"
         FROM (SELECT kind,bytes AS data_limit_bytes,previous_bytes,
           duration,event_status,counterpart_status,previous_event_status,
           ordered_previous,ambiguous_counterpart,duration_conflict,
           boundary_first_pair
           FROM operation_rows) grouped
         GROUP BY kind,data_limit_bytes,previous_bytes,duration,event_status,
           counterpart_status,previous_event_status,ordered_previous,
           ambiguous_counterpart,duration_conflict,boundary_first_pair
         LIMIT 70001`,
        [source, this.correlationWindowSeconds],
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

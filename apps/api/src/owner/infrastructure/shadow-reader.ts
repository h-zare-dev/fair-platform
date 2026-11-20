import type { DataSource } from 'typeorm';

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
  constructor(private readonly db: DataSource) {}

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

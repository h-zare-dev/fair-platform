import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ShadowReview1792600000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_shadow_reviews (
      id uuid PRIMARY KEY, day_id bigint NOT NULL REFERENCES fair_shadow_days,
      package_id bigint REFERENCES fair_atomic_packages,
      amount_toman bigint NOT NULL, package_bytes bigint NOT NULL,
      decided_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((package_id IS NULL AND amount_toman=0 AND package_bytes=0)
        OR (package_id IS NOT NULL AND amount_toman>0 AND package_bytes>0))
    )`);
    await r.query(`CREATE TABLE fair_shadow_review_events (
      event_id bigint PRIMARY KEY, review_id uuid NOT NULL REFERENCES fair_shadow_reviews
    )`);
    await r.query(`CREATE VIEW fair_shadow_day_reports AS SELECT d.source_instance_id AS source,d.billing_admin_id::text AS admin,d.local_day AS day,d.id AS day_id,
         (i.amount+r.amount) AS amount_toman,(i.bytes+r.bytes) AS sold_bytes,
         (i.pending+l.pending)::integer AS pending
       FROM fair_shadow_days d
       CROSS JOIN LATERAL (SELECT coalesce(sum(amount_toman),0) AS amount,
         coalesce(sum(data_limit_bytes) FILTER(WHERE amount_toman IS NOT NULL),0) AS bytes,
         count(*) FILTER(WHERE reason_code IS NOT NULL AND reason_code NOT IN ('RENEWAL_EVIDENCE','UNCHANGED_OR_DECREASED') AND v.event_id IS NULL) AS pending
         FROM fair_shadow_items i LEFT JOIN fair_shadow_review_events v USING(event_id)
         WHERE i.day_id=d.id) i
       CROSS JOIN LATERAL (SELECT count(*) AS pending FROM fair_shadow_late_events l
         WHERE l.day_id=d.id AND NOT EXISTS(SELECT FROM fair_shadow_review_events v WHERE v.event_id=l.event_id)) l
       CROSS JOIN LATERAL (SELECT coalesce(sum(amount_toman),0) AS amount,coalesce(sum(package_bytes),0) AS bytes
         FROM fair_shadow_reviews WHERE day_id=d.id) r`);
    for (const table of ['fair_shadow_reviews', 'fair_shadow_review_events']) {
      await r.query(`CREATE TRIGGER shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION fair_shadow_immutable()`);
    }
    await r.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT ON fair_shadow_day_reports TO fair_owner_runtime;
      GRANT SELECT,INSERT ON fair_shadow_reviews,fair_shadow_review_events TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP VIEW fair_shadow_day_reports');
    await r.query('DROP TABLE fair_shadow_review_events, fair_shadow_reviews');
  }
}

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
    for (const table of ['fair_shadow_reviews', 'fair_shadow_review_events']) {
      await r.query(`CREATE TRIGGER shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION fair_shadow_immutable()`);
    }
    await r.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT,INSERT ON fair_shadow_reviews,fair_shadow_review_events TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP TABLE fair_shadow_review_events, fair_shadow_reviews');
  }
}

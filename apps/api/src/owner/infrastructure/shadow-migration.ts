import type { MigrationInterface, QueryRunner } from 'typeorm';

/** FP-005: append-only, test-only nightly create evidence. No live billing. */
export class FairShadowCreate1791600000000 implements MigrationInterface {
  name = 'FairShadowCreate1791600000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_shadow_days (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      billing_admin_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      time_zone varchar(100) NOT NULL,
      window_start timestamptz NOT NULL,
      window_end timestamptz NOT NULL,
      source_watermark timestamptz NOT NULL,
      group_id_at_close bigint,
      status varchar(20) NOT NULL CHECK (status IN ('SHADOW_READY','PENDING_REVIEW')),
      total_toman bigint CHECK (total_toman >= 0),
      create_count integer NOT NULL CHECK (create_count >= 0),
      ambiguity_count integer NOT NULL CHECK (ambiguity_count >= 0),
      processed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_instance_id,billing_admin_id,local_day),
      CHECK (window_start < window_end),
      CHECK ((status='PENDING_REVIEW' AND total_toman IS NULL AND ambiguity_count > 0)
        OR (status='SHADOW_READY' AND total_toman IS NOT NULL AND ambiguity_count = 0))
    )`);
    await r.query(`CREATE TABLE fair_shadow_items (
      -- An INSERT trigger validates event existence. A physical FK to the
      -- legacy table blocks its independent synthetic test reset even when
      -- no Shadow rows exist; runtime has no DELETE permission on either.
      event_id bigint PRIMARY KEY,
      day_id bigint NOT NULL REFERENCES fair_shadow_days(id),
      source_instance_id varchar(100) NOT NULL,
      billing_admin_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      reason_code varchar(64),
      amount_toman bigint CHECK (amount_toman > 0),
      matched_package_id bigint,
      matched_assignment_id bigint,
      data_limit_bytes bigint NOT NULL,
      duration_days integer,
      source_enqueued_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((reason_code IS NULL AND amount_toman IS NOT NULL)
        OR (reason_code IS NOT NULL AND amount_toman IS NULL))
    )`);
    await r.query(`CREATE INDEX fair_shadow_items_open
      ON fair_shadow_items(source_instance_id,billing_admin_id,local_day,reason_code)
      WHERE reason_code IS NOT NULL`);
    await r.query(`CREATE TABLE fair_shadow_late_events (
      event_id bigint PRIMARY KEY,
      day_id bigint NOT NULL REFERENCES fair_shadow_days(id),
      source_instance_id varchar(100) NOT NULL,
      billing_admin_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      reason_code varchar(64) NOT NULL DEFAULT 'LATE_EVENT_AFTER_CLOSE'
        CHECK (reason_code='LATE_EVENT_AFTER_CLOSE'),
      discovered_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(`CREATE FUNCTION fair_shadow_event_exists() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pasarguard_events WHERE id=NEW.event_id)
        THEN RAISE EXCEPTION 'SHADOW_EVENT_MISSING'; END IF;
        RETURN NEW;
      END $$`);
    for (const table of ['fair_shadow_items', 'fair_shadow_late_events']) {
      await r.query(`CREATE TRIGGER shadow_event_valid BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION fair_shadow_event_exists()`);
    }
    await r.query(`CREATE FUNCTION fair_shadow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SHADOW_EVIDENCE_IMMUTABLE'; END $$`);
    for (const table of [
      'fair_shadow_days',
      'fair_shadow_items',
      'fair_shadow_late_events',
    ]) {
      await r.query(`CREATE TRIGGER shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION fair_shadow_immutable()`);
    }
    await r.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT,INSERT ON fair_shadow_days,fair_shadow_items,fair_shadow_late_events TO fair_owner_runtime;
      GRANT USAGE ON SEQUENCE fair_shadow_days_id_seq TO fair_owner_runtime;
      GRANT SELECT,INSERT,UPDATE ON pasarguard_webhook_batches,pasarguard_events,pasarguard_ingestion_issues TO fair_owner_runtime;
      GRANT USAGE ON SEQUENCE pasarguard_webhook_batches_id_seq,pasarguard_events_id_seq,pasarguard_ingestion_issues_id_seq TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP TABLE fair_shadow_late_events');
    await r.query('DROP TABLE fair_shadow_items');
    await r.query('DROP TABLE fair_shadow_days');
    await r.query('DROP FUNCTION fair_shadow_event_exists()');
    await r.query('DROP FUNCTION fair_shadow_immutable()');
  }
}

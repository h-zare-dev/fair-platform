import type { MigrationInterface, QueryRunner } from 'typeorm';

/** FP-006 opening snapshots are non-financial evidence, never ledger entries. */
export class OpeningBaseline1791700000000 implements MigrationInterface {
  name = 'OpeningBaseline1791700000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_opening_baseline_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      status varchar(16) NOT NULL CHECK (status IN ('PENDING','SCANNING','VERIFYING','COMPLETE','FAILED')),
      phase varchar(10) NOT NULL DEFAULT 'SCAN' CHECK (phase IN ('SCAN','VERIFY')),
      next_offset integer NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
      source_total integer CHECK (source_total >= 0),
      verified_total integer CHECK (verified_total >= 0),
      failure_code varchar(40),
      lease_token uuid,
      lease_until timestamptz,
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      finished_at timestamptz,
      CHECK ((lease_token IS NULL) = (lease_until IS NULL))
    )`);
    await r.query(`CREATE UNIQUE INDEX fair_one_opening_run_per_source
      ON fair_opening_baseline_runs (source_instance_id)
      WHERE status IN ('PENDING','SCANNING','VERIFYING')`);
    await r.query(`CREATE TABLE fair_opening_baseline_users (
      run_id bigint NOT NULL REFERENCES fair_opening_baseline_runs(id),
      external_user_id bigint NOT NULL CHECK (external_user_id > 0),
      billing_admin_id bigint CHECK (billing_admin_id >= 0),
      user_status varchar(12) NOT NULL,
      data_limit_bytes bigint CHECK (data_limit_bytes >= 0),
      used_traffic_bytes bigint NOT NULL CHECK (used_traffic_bytes >= 0),
      expires_at timestamptz,
      on_hold_duration_seconds bigint CHECK (on_hold_duration_seconds >= 0),
      reset_strategy varchar(40),
      source_created_at timestamptz NOT NULL,
      source_edited_at timestamptz,
      fingerprint char(64) NOT NULL,
      verified_fingerprint char(64),
      verification_status varchar(12) NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (verification_status IN ('UNVERIFIED','STABLE','CHANGED','MISSING','ADDED')),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (run_id, external_user_id)
    )`);
    await r.query(`CREATE INDEX fair_opening_users_verification
      ON fair_opening_baseline_users(run_id, verification_status)`);
    // The first sample is immutable; only the verification columns may be populated.
    await r.query(`CREATE FUNCTION fair_opening_baseline_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OPENING_BASELINE_IMMUTABLE'; END IF;
      IF EXISTS (SELECT 1 FROM fair_opening_baseline_runs WHERE id=OLD.run_id AND status IN ('COMPLETE','FAILED'))
      THEN RAISE EXCEPTION 'OPENING_BASELINE_IMMUTABLE'; END IF;
      IF (NEW.run_id,NEW.external_user_id,NEW.billing_admin_id,NEW.user_status,NEW.data_limit_bytes,
          NEW.used_traffic_bytes,NEW.expires_at,NEW.on_hold_duration_seconds,NEW.reset_strategy,
          NEW.source_created_at,NEW.source_edited_at,NEW.fingerprint,NEW.captured_at)
         IS DISTINCT FROM
         (OLD.run_id,OLD.external_user_id,OLD.billing_admin_id,OLD.user_status,OLD.data_limit_bytes,
          OLD.used_traffic_bytes,OLD.expires_at,OLD.on_hold_duration_seconds,OLD.reset_strategy,
          OLD.source_created_at,OLD.source_edited_at,OLD.fingerprint,OLD.captured_at)
      THEN RAISE EXCEPTION 'OPENING_BASELINE_IMMUTABLE'; END IF;
      IF OLD.verification_status <> 'UNVERIFIED' THEN RAISE EXCEPTION 'OPENING_BASELINE_IMMUTABLE'; END IF;
      RETURN NEW;
    END $$`);
    await r.query(`CREATE TRIGGER opening_baseline_guard BEFORE UPDATE OR DELETE ON fair_opening_baseline_users
      FOR EACH ROW EXECUTE FUNCTION fair_opening_baseline_guard()`);
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        GRANT SELECT,INSERT,UPDATE ON fair_opening_baseline_runs,fair_opening_baseline_users TO fair_owner_runtime;
        GRANT USAGE ON SEQUENCE fair_opening_baseline_runs_id_seq TO fair_owner_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_backup') THEN
        GRANT SELECT ON fair_opening_baseline_runs,fair_opening_baseline_users TO fair_backup;
      END IF;
    END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    // Test databases only: real environments use forward-only migrations.
    await r.query('DROP TABLE fair_opening_baseline_users');
    await r.query('DROP FUNCTION fair_opening_baseline_guard()');
    await r.query('DROP TABLE fair_opening_baseline_runs');
  }
}

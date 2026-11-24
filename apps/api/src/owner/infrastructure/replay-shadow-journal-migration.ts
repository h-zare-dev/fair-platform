import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Historical source `replay-30d`, Owner-attested tariffs, no LIVE side effects. */
export class ReplayShadowJournal1791900000000 implements MigrationInterface {
  name = 'ReplayShadowJournal1791900000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_replay_shadow_runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_key uuid NOT NULL UNIQUE,
      source_instance_id varchar(100) NOT NULL DEFAULT 'replay-30d'
        CHECK (source_instance_id='replay-30d'),
      status varchar(16) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','COMPLETE','FAILED')),
      time_zone varchar(100) NOT NULL,
      correlation_window_seconds integer NOT NULL
        CHECK (correlation_window_seconds BETWEEN 1 AND 600),
      delete_credit_enabled boolean NOT NULL,
      catalog_hash char(64),
      event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
      ignored_count integer NOT NULL DEFAULT 0 CHECK (ignored_count >= 0),
      entry_count integer NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
      held_count integer NOT NULL DEFAULT 0 CHECK (held_count >= 0),
      held_candidate_count integer NOT NULL DEFAULT 0 CHECK (held_candidate_count >= 0),
      failure_code varchar(64),
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`);
    await r.query(`CREATE UNIQUE INDEX fair_replay_shadow_pending
      ON fair_replay_shadow_runs(source_instance_id)
      WHERE status='PENDING'`);
    await r.query(`CREATE TABLE fair_replay_shadow_days (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      billing_admin_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      status varchar(20) NOT NULL
        CHECK (status IN ('SHADOW_READY','PENDING_REVIEW')),
      charge_toman bigint CHECK (charge_toman >= 0),
      credit_toman bigint CHECK (credit_toman >= 0),
      net_toman bigint,
      entry_count integer NOT NULL CHECK (entry_count >= 0),
      hold_count integer NOT NULL CHECK (hold_count >= 0),
      PRIMARY KEY (run_id,billing_admin_id,local_day),
      CHECK ((status='SHADOW_READY' AND hold_count=0 AND charge_toman IS NOT NULL
        AND credit_toman IS NOT NULL AND net_toman=charge_toman-credit_toman)
        OR (status='PENDING_REVIEW' AND hold_count>0 AND entry_count=0
        AND charge_toman IS NULL AND credit_toman IS NULL AND net_toman IS NULL))
    )`);
    await r.query(`CREATE TABLE fair_replay_shadow_entries (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      operation_key varchar(128) NOT NULL,
      kind varchar(32) NOT NULL,
      entry_type varchar(8) NOT NULL CHECK (entry_type IN ('CHARGE','CREDIT')),
      billing_admin_id bigint NOT NULL,
      external_user_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      occurred_at timestamptz NOT NULL,
      source_event_ids bigint[] NOT NULL CHECK (cardinality(source_event_ids) BETWEEN 1 AND 2),
      amount_toman bigint NOT NULL CHECK (amount_toman > 0),
      package_id bigint NOT NULL,
      reference_operation_key varchar(128),
      PRIMARY KEY (run_id,operation_key),
      FOREIGN KEY (run_id,billing_admin_id,local_day)
        REFERENCES fair_replay_shadow_days(run_id,billing_admin_id,local_day),
      CHECK ((entry_type='CHARGE' AND reference_operation_key IS NULL)
        OR (entry_type='CREDIT' AND reference_operation_key IS NOT NULL))
    )`);
    await r.query(`CREATE TABLE fair_replay_shadow_holds (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      operation_key varchar(128) NOT NULL,
      reason_code varchar(64) NOT NULL,
      billing_admin_id bigint NOT NULL,
      external_user_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      occurred_at timestamptz NOT NULL,
      source_event_ids bigint[] NOT NULL CHECK (cardinality(source_event_ids) BETWEEN 1 AND 2),
      PRIMARY KEY (run_id,operation_key),
      FOREIGN KEY (run_id,billing_admin_id,local_day)
        REFERENCES fair_replay_shadow_days(run_id,billing_admin_id,local_day)
    )`);
    await r.query(`CREATE INDEX fair_replay_shadow_held_reason
      ON fair_replay_shadow_holds(run_id,reason_code)`);
    await r.query(`CREATE FUNCTION fair_replay_shadow_evidence_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'REPLAY_SHADOW_EVIDENCE_IMMUTABLE'; END $$`);
    for (const table of [
      'fair_replay_shadow_days',
      'fair_replay_shadow_entries',
      'fair_replay_shadow_holds',
    ]) {
      await r.query(`CREATE TRIGGER replay_shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
        ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION fair_replay_shadow_evidence_immutable()`);
    }
    await r.query(`CREATE FUNCTION fair_replay_shadow_run_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REPLAY_SHADOW_RUN_IMMUTABLE'; END IF;
        IF OLD.status<>'PENDING' OR NEW.status NOT IN ('COMPLETE','FAILED')
          OR (NEW.request_key,NEW.source_instance_id,NEW.time_zone,
              NEW.correlation_window_seconds,NEW.delete_credit_enabled)
             IS DISTINCT FROM
             (OLD.request_key,OLD.source_instance_id,OLD.time_zone,
              OLD.correlation_window_seconds,OLD.delete_credit_enabled)
        THEN RAISE EXCEPTION 'REPLAY_SHADOW_RUN_IMMUTABLE'; END IF;
        RETURN NEW;
      END $$`);
    await r.query(`CREATE TRIGGER replay_shadow_run_guard BEFORE UPDATE OR DELETE
      ON fair_replay_shadow_runs FOR EACH ROW EXECUTE FUNCTION fair_replay_shadow_run_guard()`);
    await r.query(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT,INSERT,UPDATE(status,catalog_hash,event_count,ignored_count,
        entry_count,held_count,held_candidate_count,failure_code,finished_at)
        ON fair_replay_shadow_runs TO fair_owner_runtime;
      GRANT SELECT,INSERT ON fair_replay_shadow_days,fair_replay_shadow_entries,
        fair_replay_shadow_holds TO fair_owner_runtime;
      GRANT USAGE ON SEQUENCE fair_replay_shadow_runs_id_seq TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP TABLE fair_replay_shadow_holds');
    await r.query('DROP TABLE fair_replay_shadow_entries');
    await r.query('DROP TABLE fair_replay_shadow_days');
    await r.query('DROP TABLE fair_replay_shadow_runs');
    await r.query('DROP FUNCTION fair_replay_shadow_evidence_immutable');
    await r.query('DROP FUNCTION fair_replay_shadow_run_guard');
  }
}

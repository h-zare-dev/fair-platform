import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive, immutable evidence only; no LIVE accounting or balance changes. */
export class ReplayShadowAudit1792000000000 implements MigrationInterface {
  name = 'ReplayShadowAudit1792000000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_replay_shadow_audit_prices (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      package_id bigint NOT NULL,
      package_bytes bigint NOT NULL CHECK (package_bytes>0),
      duration_days integer NOT NULL CHECK (duration_days>0),
      amount_toman bigint NOT NULL CHECK (amount_toman>0),
      PRIMARY KEY(run_id,package_id),
      UNIQUE(run_id,package_bytes,duration_days)
    )`);
    await r.query(`CREATE TABLE fair_replay_shadow_held_candidates (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      operation_key varchar(128) NOT NULL,
      kind varchar(32) NOT NULL,
      entry_type varchar(8) NOT NULL CHECK(entry_type IN ('CHARGE','CREDIT')),
      billing_admin_id bigint NOT NULL,
      external_user_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      occurred_at timestamptz NOT NULL,
      source_event_ids bigint[] NOT NULL CHECK(cardinality(source_event_ids) BETWEEN 1 AND 2),
      amount_toman bigint NOT NULL CHECK(amount_toman>0),
      package_id bigint NOT NULL,
      reference_operation_key varchar(128),
      PRIMARY KEY(run_id,operation_key),
      FOREIGN KEY(run_id,billing_admin_id,local_day)
        REFERENCES fair_replay_shadow_days(run_id,billing_admin_id,local_day),
      FOREIGN KEY(run_id,package_id)
        REFERENCES fair_replay_shadow_audit_prices(run_id,package_id)
    )`);
    await r.query(`CREATE INDEX fair_replay_shadow_held_candidates_day
      ON fair_replay_shadow_held_candidates(run_id,billing_admin_id,local_day,operation_key)`);
    await r.query(`CREATE TABLE fair_replay_shadow_ignored_summary (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      action varchar(64) NOT NULL,
      reason varchar(64) NOT NULL,
      event_count integer NOT NULL CHECK(event_count>0),
      PRIMARY KEY(run_id,action,reason)
    )`);
    await r.query(`CREATE INDEX fair_replay_shadow_entries_admin_day
      ON fair_replay_shadow_entries(run_id,billing_admin_id,local_day,operation_key)`);
    await r.query(`CREATE INDEX fair_replay_shadow_holds_admin_day
      ON fair_replay_shadow_holds(run_id,billing_admin_id,local_day,operation_key)`);
    for (const table of [
      'fair_replay_shadow_audit_prices',
      'fair_replay_shadow_held_candidates',
      'fair_replay_shadow_ignored_summary',
    ]) {
      await r.query(`CREATE TRIGGER replay_shadow_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
        ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION fair_replay_shadow_evidence_immutable()`);
    }
    await r.query(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT,INSERT ON fair_replay_shadow_audit_prices,
        fair_replay_shadow_held_candidates,fair_replay_shadow_ignored_summary
        TO fair_owner_runtime;
      GRANT SELECT (id,source_instance_id,action,external_user_id,username,
        billing_admin_id,billing_admin_username,actor_admin_id,actor_admin_username,
        source_enqueued_at,data_limit_bytes,on_hold_expire_duration_seconds,
        user_status,event_status) ON pasarguard_events TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP INDEX fair_replay_shadow_holds_admin_day');
    await r.query('DROP INDEX fair_replay_shadow_entries_admin_day');
    await r.query('DROP TABLE fair_replay_shadow_ignored_summary');
    await r.query('DROP TABLE fair_replay_shadow_held_candidates');
    await r.query('DROP TABLE fair_replay_shadow_audit_prices');
  }
}

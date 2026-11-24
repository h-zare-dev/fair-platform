import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A forward-only, auditable selection; imported account evidence remains immutable. */
export class OpeningBaselineControl1791800000000 implements MigrationInterface {
  name = 'OpeningBaselineControl1791800000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_opening_baseline_control (
      source_instance_id varchar(100) PRIMARY KEY,
      current_run_id bigint REFERENCES fair_opening_baseline_runs(id),
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      financial_cutover_started_at timestamptz,
      changed_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((generation=0 AND current_run_id IS NULL)
        OR (generation>0 AND current_run_id IS NOT NULL))
    )`);
    await r.query(`CREATE TABLE fair_opening_baseline_reseed_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      request_key uuid NOT NULL,
      old_run_id bigint REFERENCES fair_opening_baseline_runs(id),
      new_run_id bigint NOT NULL REFERENCES fair_opening_baseline_runs(id),
      generation bigint NOT NULL CHECK (generation > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_instance_id,request_key),
      UNIQUE (source_instance_id,generation)
    )`);
    // The Owner's already-completed prior runs are visible as the initial
    // selection. They are never copied or altered by this migration.
    await r.query(`INSERT INTO fair_opening_baseline_control
        (source_instance_id,current_run_id,generation)
      SELECT source_instance_id,MAX(id),1
      FROM fair_opening_baseline_runs GROUP BY source_instance_id`);
    await r.query(`CREATE FUNCTION fair_opening_baseline_audit_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'OPENING_BASELINE_AUDIT_IMMUTABLE'; END $$`);
    await r.query(`CREATE TRIGGER opening_baseline_reseed_audit_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON fair_opening_baseline_reseed_audit
      FOR EACH STATEMENT EXECUTE FUNCTION fair_opening_baseline_audit_immutable()`);
    await r.query(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT,INSERT,UPDATE (current_run_id,generation,changed_at)
        ON fair_opening_baseline_control TO fair_owner_runtime;
      GRANT SELECT,INSERT ON fair_opening_baseline_reseed_audit
        TO fair_owner_runtime;
      GRANT USAGE ON SEQUENCE fair_opening_baseline_reseed_audit_id_seq
        TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP TABLE fair_opening_baseline_reseed_audit');
    await r.query('DROP TABLE fair_opening_baseline_control');
    await r.query('DROP FUNCTION fair_opening_baseline_audit_immutable');
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** FP-004 synthetic pricing configuration. Version contents are append-only. */
export class PricingEngine1791200000000 implements MigrationInterface {
  name = 'PricingEngine1791200000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await r.query(`CREATE TABLE fair_pricing_plans (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL CHECK (source_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'),
      name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, source_instance_id), UNIQUE (source_instance_id, name)
    )`);
    await r.query(`CREATE TABLE fair_pricing_rule_versions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL CHECK (source_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'),
      plan_id bigint,
      billing_admin_id bigint CHECK (billing_admin_id >= 0),
      mode varchar(10) NOT NULL CHECK (mode IN ('PER_GIB','FIXED','MIXED')),
      rate_toman_per_gib bigint CHECK (rate_toman_per_gib > 0),
      effective_from timestamptz NOT NULL,
      effective_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pricing_rule_owner CHECK ((plan_id IS NULL) <> (billing_admin_id IS NULL)),
      CONSTRAINT pricing_rule_mode CHECK ((mode='FIXED' AND rate_toman_per_gib IS NULL) OR (mode='PER_GIB' AND rate_toman_per_gib IS NOT NULL) OR mode='MIXED'),
      CONSTRAINT pricing_rule_window CHECK (effective_until IS NULL OR effective_until > effective_from),
      CONSTRAINT pricing_rule_plan_fk FOREIGN KEY (plan_id,source_instance_id) REFERENCES fair_pricing_plans(id,source_instance_id),
      CONSTRAINT pricing_plan_period EXCLUDE USING gist (plan_id WITH =, tstzrange(effective_from,effective_until,'[)') WITH &&) WHERE (plan_id IS NOT NULL),
      CONSTRAINT pricing_override_period EXCLUDE USING gist (source_instance_id WITH =, billing_admin_id WITH =, tstzrange(effective_from,effective_until,'[)') WITH &&) WHERE (billing_admin_id IS NOT NULL)
    )`);
    await r.query(`CREATE TABLE fair_pricing_fixed_packages (
      rule_version_id bigint NOT NULL REFERENCES fair_pricing_rule_versions(id),
      package_bytes bigint NOT NULL CHECK (package_bytes > 0),
      amount_toman bigint NOT NULL CHECK (amount_toman > 0),
      PRIMARY KEY (rule_version_id, package_bytes)
    )`);
    await r.query(`CREATE TABLE fair_pricing_assignments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL CHECK (source_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'),
      billing_admin_id bigint CHECK (billing_admin_id >= 0),
      plan_id bigint NOT NULL,
      effective_from timestamptz NOT NULL,
      effective_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pricing_assignment_window CHECK (effective_until IS NULL OR effective_until > effective_from),
      CONSTRAINT pricing_assignment_plan_fk FOREIGN KEY (plan_id,source_instance_id) REFERENCES fair_pricing_plans(id,source_instance_id),
      CONSTRAINT pricing_default_period EXCLUDE USING gist (source_instance_id WITH =, tstzrange(effective_from,effective_until,'[)') WITH &&) WHERE (billing_admin_id IS NULL),
      CONSTRAINT pricing_admin_period EXCLUDE USING gist (source_instance_id WITH =, billing_admin_id WITH =, tstzrange(effective_from,effective_until,'[)') WITH &&) WHERE (billing_admin_id IS NOT NULL)
    )`);
    await r.query(`CREATE TABLE fair_pricing_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      action varchar(24) NOT NULL CHECK (action IN ('CREATE_PLAN','CREATE_RULE','ASSIGN_PLAN')),
      object_id bigint NOT NULL,
      source_instance_id varchar(100) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Immutable plan identity, rule prices, fixed catalogs and assignments: revisions create new rows.
    await r.query(`CREATE FUNCTION fair_pricing_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'PRICING_IMMUTABLE'; END
    $$`);
    for (const table of [
      'fair_pricing_plans',
      'fair_pricing_rule_versions',
      'fair_pricing_fixed_packages',
      'fair_pricing_assignments',
      'fair_pricing_audit',
    ])
      await r.query(
        `CREATE TRIGGER immutable_${table} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fair_pricing_immutable()`,
      );
    await r.query(
      'CREATE INDEX pricing_rules_source_time ON fair_pricing_rule_versions (source_instance_id, effective_from)',
    );
    await r.query(
      'CREATE INDEX pricing_assignments_source_time ON fair_pricing_assignments (source_instance_id, effective_from)',
    );
    // The staging deployment uses a non-owner runtime role. It only receives
    // append-only pricing writes, and the local backup role gets SELECT.
    // An empty disposable DB may not have either role yet.
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        GRANT SELECT,INSERT ON fair_pricing_plans,fair_pricing_rule_versions,fair_pricing_fixed_packages,fair_pricing_assignments TO fair_owner_runtime;
        GRANT INSERT ON fair_pricing_audit TO fair_owner_runtime;
        GRANT USAGE ON SEQUENCE fair_pricing_plans_id_seq,fair_pricing_rule_versions_id_seq,fair_pricing_assignments_id_seq,fair_pricing_audit_id_seq TO fair_owner_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_backup') THEN
        GRANT SELECT ON fair_pricing_plans,fair_pricing_rule_versions,fair_pricing_fixed_packages,fair_pricing_assignments,fair_pricing_audit TO fair_backup;
      END IF;
    END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    // Forward-only in deployed environments; down exists for disposable migration tests.
    for (const table of [
      'fair_pricing_audit',
      'fair_pricing_assignments',
      'fair_pricing_fixed_packages',
      'fair_pricing_rule_versions',
      'fair_pricing_plans',
    ])
      await r.query(`DROP TABLE ${table}`);
    await r.query('DROP FUNCTION fair_pricing_immutable()');
  }
}

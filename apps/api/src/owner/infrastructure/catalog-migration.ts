import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive FP-004 Phase A. Never reinterpret pre-existing synthetic pricing rows. */
export class AtomicCatalog1791300000000 implements MigrationInterface {
  name = 'AtomicCatalog1791300000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_admin_groups (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, source_instance_id), UNIQUE (source_instance_id, name)
    )`);
    await r.query(`CREATE TABLE fair_admin_group_memberships (
      source_instance_id varchar(100) NOT NULL,
      billing_admin_id bigint NOT NULL CHECK (billing_admin_id >= 0),
      group_id bigint NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (source_instance_id, billing_admin_id),
      FOREIGN KEY (group_id, source_instance_id) REFERENCES fair_admin_groups(id, source_instance_id)
    )`);
    await r.query(`CREATE TABLE fair_admin_group_membership_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      billing_admin_id bigint NOT NULL,
      old_group_id bigint,
      new_group_id bigint,
      action varchar(12) NOT NULL CHECK (action IN ('ASSIGN','REMOVE','TRANSFER')),
      actor varchar(40) NOT NULL DEFAULT 'OWNER',
      changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (old_group_id IS DISTINCT FROM new_group_id)
    )`);
    await r.query(`CREATE TABLE fair_atomic_packages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      name varchar(100) NOT NULL CHECK (length(trim(name)) > 0),
      package_bytes bigint NOT NULL CHECK (package_bytes > 0),
      duration_days integer NOT NULL CHECK (duration_days > 0 AND duration_days <= 36500),
      amount_toman bigint NOT NULL CHECK (amount_toman > 0),
      ever_assigned boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, source_instance_id), UNIQUE (source_instance_id, name)
    )`);
    await r.query(`CREATE FUNCTION fair_atomic_package_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.ever_assigned THEN RAISE EXCEPTION 'PACKAGE_ALREADY_ASSIGNED'; END IF;
          RETURN OLD;
        END IF;
        IF OLD.ever_assigned AND (
          NEW.name IS DISTINCT FROM OLD.name OR
          NEW.package_bytes IS DISTINCT FROM OLD.package_bytes OR
          NEW.duration_days IS DISTINCT FROM OLD.duration_days OR
          NEW.amount_toman IS DISTINCT FROM OLD.amount_toman OR
          NEW.ever_assigned IS DISTINCT FROM OLD.ever_assigned
        ) THEN RAISE EXCEPTION 'PACKAGE_ALREADY_ASSIGNED'; END IF;
        IF NEW.source_instance_id IS DISTINCT FROM OLD.source_instance_id OR
          (OLD.ever_assigned AND NOT NEW.ever_assigned) THEN
          RAISE EXCEPTION 'PACKAGE_IDENTITY_IMMUTABLE';
        END IF;
        RETURN NEW;
      END
    $$`);
    await r.query(`CREATE TRIGGER atomic_package_guard BEFORE UPDATE OR DELETE ON fair_atomic_packages
      FOR EACH ROW EXECUTE FUNCTION fair_atomic_package_guard()`);
    await r.query(`CREATE TABLE fair_tariff_assignments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_instance_id varchar(100) NOT NULL,
      target_kind varchar(5) NOT NULL CHECK (target_kind IN ('GROUP','ADMIN')),
      group_id bigint,
      billing_admin_id bigint CHECK (billing_admin_id >= 0),
      package_id bigint,
      rate_toman_per_gib bigint CHECK (rate_toman_per_gib > 0),
      package_bytes bigint CHECK (package_bytes > 0),
      duration_days integer CHECK (duration_days > 0),
      local_start_date varchar(10) NOT NULL,
      local_end_date varchar(10),
      time_zone varchar(100) NOT NULL,
      effective_from timestamptz NOT NULL,
      effective_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((target_kind='GROUP' AND group_id IS NOT NULL AND billing_admin_id IS NULL)
          OR (target_kind='ADMIN' AND billing_admin_id IS NOT NULL AND group_id IS NULL)),
      CHECK ((package_id IS NOT NULL AND rate_toman_per_gib IS NULL AND package_bytes IS NOT NULL AND duration_days IS NOT NULL)
          OR (package_id IS NULL AND rate_toman_per_gib IS NOT NULL AND package_bytes IS NULL AND duration_days IS NULL)),
      CHECK (effective_until IS NULL OR effective_until > effective_from),
      FOREIGN KEY (group_id, source_instance_id) REFERENCES fair_admin_groups(id,source_instance_id),
      FOREIGN KEY (package_id, source_instance_id) REFERENCES fair_atomic_packages(id,source_instance_id)
    )`);
    await r.query(`CREATE INDEX fair_tariff_target_lookup ON fair_tariff_assignments
      (source_instance_id, target_kind, group_id, billing_admin_id, effective_from)`);
    // Transaction-scoped target lock also protects against overlapping FIXED vs PER_GIB
    // writes that cannot be described by one GiST same-shape exclusion.
    await r.query(`CREATE FUNCTION fair_tariff_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE current_local_date date;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF (NEW.source_instance_id,NEW.target_kind,NEW.group_id,NEW.billing_admin_id,
              NEW.package_id,NEW.rate_toman_per_gib,NEW.package_bytes,NEW.duration_days,
              NEW.local_start_date,NEW.time_zone,NEW.effective_from,NEW.created_at,NEW.id)
             IS DISTINCT FROM
             (OLD.source_instance_id,OLD.target_kind,OLD.group_id,OLD.billing_admin_id,
              OLD.package_id,OLD.rate_toman_per_gib,OLD.package_bytes,OLD.duration_days,
              OLD.local_start_date,OLD.time_zone,OLD.effective_from,OLD.created_at,OLD.id)
          THEN RAISE EXCEPTION 'ASSIGNMENT_START_IMMUTABLE'; END IF;
          current_local_date := (now() AT TIME ZONE OLD.time_zone)::date;
          IF (OLD.effective_until IS NOT NULL AND OLD.effective_until <=
                ((current_local_date + 1)::timestamp AT TIME ZONE OLD.time_zone)) OR
             (NEW.effective_until IS NOT NULL AND NEW.effective_until <=
                ((current_local_date + 1)::timestamp AT TIME ZONE OLD.time_zone))
          THEN RAISE EXCEPTION 'ASSIGNMENT_CLOSED_PERIOD'; END IF;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.source_instance_id || ':' || NEW.target_kind || ':' ||
          COALESCE(NEW.group_id::text, NEW.billing_admin_id::text), 0));
        IF EXISTS (
          SELECT 1 FROM fair_tariff_assignments a
          WHERE a.source_instance_id=NEW.source_instance_id AND a.target_kind=NEW.target_kind
            AND a.group_id IS NOT DISTINCT FROM NEW.group_id
            AND a.billing_admin_id IS NOT DISTINCT FROM NEW.billing_admin_id
            AND a.id IS DISTINCT FROM NEW.id
            AND tstzrange(a.effective_from,a.effective_until,'[)') &&
                tstzrange(NEW.effective_from,NEW.effective_until,'[)')
            AND (a.package_id IS NULL OR NEW.package_id IS NULL OR
                 (a.package_bytes=NEW.package_bytes AND a.duration_days=NEW.duration_days))
        ) THEN RAISE EXCEPTION 'TARIFF_ASSIGNMENT_CONFLICT' USING ERRCODE='23P01'; END IF;
        RETURN NEW;
      END
    $$`);
    await r.query(`CREATE TRIGGER tariff_assignment_guard BEFORE INSERT OR UPDATE ON fair_tariff_assignments
      FOR EACH ROW EXECUTE FUNCTION fair_tariff_assignment_guard()`);
    await r.query(`CREATE FUNCTION fair_membership_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'MEMBERSHIP_AUDIT_IMMUTABLE'; END
    $$`);
    await r.query(`CREATE TRIGGER membership_audit_immutable BEFORE UPDATE OR DELETE ON fair_admin_group_membership_audit
      FOR EACH ROW EXECUTE FUNCTION fair_membership_audit_immutable()`);
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        GRANT SELECT,INSERT ON fair_admin_groups TO fair_owner_runtime;
        GRANT SELECT,INSERT,UPDATE ON fair_admin_group_memberships,fair_atomic_packages,fair_tariff_assignments TO fair_owner_runtime;
        GRANT DELETE ON fair_admin_group_memberships TO fair_owner_runtime;
        GRANT SELECT,INSERT ON fair_admin_group_membership_audit TO fair_owner_runtime;
        GRANT USAGE ON SEQUENCE fair_admin_groups_id_seq,fair_admin_group_membership_audit_id_seq,fair_atomic_packages_id_seq,fair_tariff_assignments_id_seq TO fair_owner_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_backup') THEN
        GRANT SELECT ON fair_admin_groups,fair_admin_group_memberships,fair_admin_group_membership_audit,fair_atomic_packages,fair_tariff_assignments TO fair_backup;
      END IF;
    END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    // Disposable test database only: production deployments use forward-only migrations.
    await r.query('DROP TABLE fair_tariff_assignments');
    await r.query('DROP FUNCTION fair_tariff_assignment_guard()');
    await r.query('DROP TABLE fair_atomic_packages');
    await r.query('DROP FUNCTION fair_atomic_package_guard()');
    await r.query('DROP TABLE fair_admin_group_membership_audit');
    await r.query('DROP FUNCTION fair_membership_audit_immutable()');
    await r.query('DROP TABLE fair_admin_group_memberships');
    await r.query('DROP TABLE fair_admin_groups');
  }
}

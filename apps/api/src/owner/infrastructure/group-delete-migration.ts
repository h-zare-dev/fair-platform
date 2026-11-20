import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Grant only the capability to delete strictly unused groups; history stays immutable. */
export class OwnerSafeGroupDelete1791400000000 implements MigrationInterface {
  name = 'OwnerSafeGroupDelete1791400000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE FUNCTION fair_unused_group_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM fair_admin_group_membership_audit
                   WHERE source_instance_id=OLD.source_instance_id
                     AND (old_group_id=OLD.id OR new_group_id=OLD.id))
           OR EXISTS (SELECT 1 FROM fair_admin_group_memberships
                      WHERE source_instance_id=OLD.source_instance_id AND group_id=OLD.id)
           OR EXISTS (SELECT 1 FROM fair_tariff_assignments
                      WHERE source_instance_id=OLD.source_instance_id AND group_id=OLD.id)
        THEN RAISE EXCEPTION 'GROUP_HAS_HISTORY'; END IF;
        RETURN OLD;
      END
    $$`);
    await r.query(`CREATE TRIGGER unused_group_delete_guard BEFORE DELETE ON fair_admin_groups
      FOR EACH ROW EXECUTE FUNCTION fair_unused_group_delete_guard()`);
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        GRANT DELETE ON fair_admin_groups TO fair_owner_runtime;
      END IF;
    END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        REVOKE DELETE ON fair_admin_groups FROM fair_owner_runtime;
      END IF;
    END $$`);
    await r.query(
      'DROP TRIGGER unused_group_delete_guard ON fair_admin_groups',
    );
    await r.query('DROP FUNCTION fair_unused_group_delete_guard()');
  }
}

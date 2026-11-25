import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Existing Staging roles predate authenticated password changes. */
export class OwnerPasswordRuntimeGrant1792400000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        GRANT UPDATE (password_hash) ON fair_owner TO fair_owner_runtime;
      END IF;
    END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
        REVOKE UPDATE (password_hash) ON fair_owner FROM fair_owner_runtime;
      END IF;
    END $$`);
  }
}

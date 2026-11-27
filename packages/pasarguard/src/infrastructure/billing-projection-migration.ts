import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Nullable, forward-only source projection. Existing fingerprints are untouched. */
export class PasarguardBillingProjection1791500000000 implements MigrationInterface {
  name = 'PasarguardBillingProjection1791500000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`ALTER TABLE pasarguard_events
      ADD COLUMN source_user_created_at timestamptz,
      ADD COLUMN source_user_expire_at timestamptz,
      ADD COLUMN source_user_edit_at timestamptz,
      ADD COLUMN on_hold_expire_duration_seconds bigint
        CHECK (on_hold_expire_duration_seconds >= 0)`);
    await r.query(`CREATE INDEX pasarguard_create_closure
      ON pasarguard_events (source_enqueued_at, source_instance_id, billing_admin_id)
      WHERE action = 'user_created'`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP INDEX pasarguard_create_closure');
    await r.query(`ALTER TABLE pasarguard_events
      DROP COLUMN source_user_created_at,
      DROP COLUMN source_user_expire_at,
      DROP COLUMN source_user_edit_at,
      DROP COLUMN on_hold_expire_duration_seconds`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Expand the existing Owner audit event allowlist for authenticated changes. */
export class OwnerPasswordChange1792200000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      'ALTER TABLE fair_owner_audit DROP CONSTRAINT fair_owner_audit_event_check',
    );
    await r.query(`ALTER TABLE fair_owner_audit ADD CONSTRAINT fair_owner_audit_event_check
      CHECK (event IN ('BOOTSTRAP','LOGIN_OK','LOGIN_DENIED','LOGOUT','RESET_PASSWORD','REVOKE_SESSIONS','CHANGE_PASSWORD'))`);
  }
  async down(r: QueryRunner): Promise<void> {
    const events = (await r.query(
      "SELECT id FROM fair_owner_audit WHERE event='CHANGE_PASSWORD' LIMIT 1",
    )) as unknown[];
    if (events.length)
      throw new Error('Cannot remove password-change audit events');
    await r.query(
      'ALTER TABLE fair_owner_audit DROP CONSTRAINT fair_owner_audit_event_check',
    );
    await r.query(`ALTER TABLE fair_owner_audit ADD CONSTRAINT fair_owner_audit_event_check
      CHECK (event IN ('BOOTSTRAP','LOGIN_OK','LOGIN_DENIED','LOGOUT','RESET_PASSWORD','REVOKE_SESSIONS'))`);
  }
}

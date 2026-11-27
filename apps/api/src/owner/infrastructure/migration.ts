import type { MigrationInterface, QueryRunner } from 'typeorm';

/** PostgreSQL singleton checks, atomic throttling and expression indexes require explicit SQL. */
export class OwnerDashboard1791000000000 implements MigrationInterface {
  name = 'OwnerDashboard1791000000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE fair_owner (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(`CREATE TABLE fair_owner_sessions (
      token_hash char(64) PRIMARY KEY, owner_id smallint NOT NULL REFERENCES fair_owner(id),
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, CHECK (expires_at > created_at)
    )`);
    await runner.query(
      'CREATE INDEX owner_sessions_expiry ON fair_owner_sessions (expires_at, last_seen_at)',
    );
    await runner.query(`CREATE TABLE fair_owner_login_budget (
      id smallint PRIMARY KEY CHECK (id = 1), started_at timestamptz NOT NULL,
      attempts integer NOT NULL CHECK (attempts > 0)
    )`);
    await runner.query(`CREATE TABLE fair_owner_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event varchar(32) NOT NULL CHECK (event IN ('BOOTSTRAP','LOGIN_OK','LOGIN_DENIED','LOGOUT','RESET_PASSWORD','REVOKE_SESSIONS')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await runner.query(
      'CREATE TABLE fair_synthetic_seed (id smallint PRIMARY KEY CHECK (id=1), created_at timestamptz NOT NULL DEFAULT now())',
    );
    await runner.query(
      'CREATE INDEX owner_audit_created ON fair_owner_audit (created_at)',
    );
    await runner.query(
      'CREATE INDEX owner_batches_window ON pasarguard_webhook_batches (source_instance_id, received_at, id)',
    );
    await runner.query(
      'CREATE INDEX owner_events_created ON pasarguard_events (source_instance_id, created_at)',
    );
    await runner.query(
      'CREATE INDEX owner_events_source_time ON pasarguard_events (source_instance_id, source_enqueued_at DESC, id DESC)',
    );
    await runner.query(
      'CREATE INDEX owner_issues_time ON pasarguard_ingestion_issues (created_at DESC, id DESC)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const index of [
      'owner_batches_window',
      'owner_events_created',
      'owner_events_source_time',
      'owner_issues_time',
    ])
      await runner.query(`DROP INDEX ${index}`);
    for (const table of [
      'fair_synthetic_seed',
      'fair_owner_audit',
      'fair_owner_login_budget',
      'fair_owner_sessions',
      'fair_owner',
    ])
      await runner.query(`DROP TABLE ${table}`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Explicit PostgreSQL identity, checks, and indexes; schema synchronization is disabled. */
export class PasarguardInbox1790000000000 implements MigrationInterface {
  name = 'PasarguardInbox1790000000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE TABLE pasarguard_webhook_batches (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source_instance_id varchar(100) NOT NULL, received_at timestamptz NOT NULL, payload_hash char(64) NOT NULL, event_count integer NOT NULL CHECK (event_count > 0), processing_status varchar(32) NOT NULL CHECK (processing_status IN ('RECEIVED','NORMALIZING','NORMALIZED','FAILED_RETRYABLE','FAILED_PERMANENT')), processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0), last_processing_at timestamptz, last_error_code varchar(64), last_error_message text, raw_payload_ciphertext bytea, raw_payload_iv bytea, raw_payload_auth_tag bytea, raw_payload_key_version smallint, raw_payload_expires_at timestamptz, raw_payload_purged_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_instance_id, payload_hash))`,
    );
    await runner.query(
      `CREATE TABLE pasarguard_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch_id bigint NOT NULL REFERENCES pasarguard_webhook_batches(id), batch_index integer NOT NULL CHECK (batch_index >= 0), source_instance_id varchar(100) NOT NULL, semantic_fingerprint char(64) NOT NULL, action varchar(64) NOT NULL, external_user_id bigint NOT NULL, username varchar(255) NOT NULL, user_status varchar(64) NOT NULL, data_limit_bytes bigint NOT NULL, used_traffic_bytes bigint NOT NULL, lifetime_used_bytes bigint NOT NULL, billing_admin_id bigint NOT NULL, billing_admin_username varchar(255) NOT NULL, actor_admin_id bigint, actor_admin_username varchar(255), source_enqueued_at timestamptz NOT NULL, source_send_at timestamptz, reset_strategy varchar(64), next_plan_data_limit_bytes bigint, next_plan_expire timestamptz, event_status varchar(32) NOT NULL CHECK (event_status IN ('READY_FOR_ACCOUNTING','IGNORED_NON_FINANCIAL','NEEDS_REVIEW')), first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_instance_id, semantic_fingerprint))`,
    );
    await runner.query(
      `CREATE TABLE pasarguard_ingestion_issues (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, batch_id bigint NOT NULL REFERENCES pasarguard_webhook_batches(id), batch_index integer, issue_code varchar(64) NOT NULL, issue_message text NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await runner.query(
      `CREATE INDEX batches_pending ON pasarguard_webhook_batches (processing_status, received_at)`,
    );
    await runner.query(
      `CREATE INDEX batches_expiry ON pasarguard_webhook_batches (raw_payload_expires_at)`,
    );
    await runner.query(
      `CREATE INDEX events_user ON pasarguard_events (external_user_id, source_enqueued_at)`,
    );
    await runner.query(
      `CREATE INDEX events_admin ON pasarguard_events (billing_admin_id, source_enqueued_at)`,
    );
    await runner.query(
      `CREATE INDEX events_action ON pasarguard_events (action, source_enqueued_at)`,
    );
    await runner.query(
      `CREATE INDEX events_status ON pasarguard_events (event_status, source_enqueued_at)`,
    );
    await runner.query(
      `CREATE INDEX issues_batch ON pasarguard_ingestion_issues (batch_id)`,
    );
    await runner.query(
      `CREATE INDEX issues_code ON pasarguard_ingestion_issues (issue_code, created_at)`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE pasarguard_ingestion_issues');
    await runner.query('DROP TABLE pasarguard_events');
    await runner.query('DROP TABLE pasarguard_webhook_batches');
  }
}

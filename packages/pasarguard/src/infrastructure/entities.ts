import { EntitySchema } from 'typeorm';
import type { NormalizedEvent } from '../normalization/normalize.js';

export interface BatchRow {
  id: string;
  source_instance_id: string;
  received_at: Date;
  payload_hash: string;
  event_count: number;
  processing_status: string;
  processing_attempts: number;
  last_processing_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  raw_payload_ciphertext: Buffer | null;
  raw_payload_iv: Buffer | null;
  raw_payload_auth_tag: Buffer | null;
  raw_payload_key_version: number | null;
  raw_payload_expires_at: Date | null;
  raw_payload_purged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface EventRow extends Omit<
  NormalizedEvent,
  'source_enqueued_at' | 'source_send_at'
> {
  id: string;
  batch_id: string;
  batch_index: number;
  source_enqueued_at: Date;
  source_send_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
  created_at: Date;
  updated_at: Date;
}
export interface IssueRow {
  id: string;
  batch_id: string;
  batch_index: number | null;
  issue_code: string;
  issue_message: string;
  created_at: Date;
  resolved_at: Date | null;
}
export const BatchEntity = new EntitySchema<BatchRow>({
  name: 'pasarguard_webhook_batches',
  tableName: 'pasarguard_webhook_batches',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    source_instance_id: { type: 'varchar', length: 100 },
    received_at: { type: 'timestamptz' },
    payload_hash: { type: 'char', length: 64 },
    event_count: { type: 'integer' },
    processing_status: { type: 'varchar', length: 32 },
    processing_attempts: { type: 'integer', default: 0 },
    last_processing_at: { type: 'timestamptz', nullable: true },
    last_error_code: { type: 'varchar', length: 64, nullable: true },
    last_error_message: { type: 'text', nullable: true },
    raw_payload_ciphertext: { type: 'bytea', nullable: true },
    raw_payload_iv: { type: 'bytea', nullable: true },
    raw_payload_auth_tag: { type: 'bytea', nullable: true },
    raw_payload_key_version: { type: 'smallint', nullable: true },
    raw_payload_expires_at: { type: 'timestamptz', nullable: true },
    raw_payload_purged_at: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
    updated_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
  },
});
export const EventEntity = new EntitySchema<EventRow>({
  name: 'pasarguard_events',
  tableName: 'pasarguard_events',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    batch_id: { type: 'bigint' },
    batch_index: { type: 'integer' },
    source_instance_id: { type: 'varchar', length: 100 },
    semantic_fingerprint: { type: 'char', length: 64 },
    action: { type: 'varchar', length: 64 },
    external_user_id: { type: 'bigint' },
    username: { type: 'varchar', length: 255 },
    user_status: { type: 'varchar', length: 64 },
    data_limit_bytes: { type: 'bigint' },
    used_traffic_bytes: { type: 'bigint' },
    lifetime_used_bytes: { type: 'bigint' },
    billing_admin_id: { type: 'bigint' },
    billing_admin_username: { type: 'varchar', length: 255 },
    actor_admin_id: { type: 'bigint', nullable: true },
    actor_admin_username: { type: 'varchar', length: 255, nullable: true },
    source_enqueued_at: { type: 'timestamptz' },
    source_send_at: { type: 'timestamptz', nullable: true },
    reset_strategy: { type: 'varchar', length: 64, nullable: true },
    next_plan_data_limit_bytes: { type: 'bigint', nullable: true },
    next_plan_expire: { type: 'timestamptz', nullable: true },
    event_status: { type: 'varchar', length: 32 },
    first_seen_at: { type: 'timestamptz' },
    last_seen_at: { type: 'timestamptz' },
    occurrence_count: { type: 'integer', default: 1 },
    created_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
    updated_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
  },
});
export const IssueEntity = new EntitySchema<IssueRow>({
  name: 'pasarguard_ingestion_issues',
  tableName: 'pasarguard_ingestion_issues',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    batch_id: { type: 'bigint' },
    batch_index: { type: 'integer', nullable: true },
    issue_code: { type: 'varchar', length: 64 },
    issue_message: { type: 'text' },
    resolved_at: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
  },
});

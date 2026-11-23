-- Run as migration/admin role after migrations. Provision fair_owner_runtime
-- and fair_backup passwords interactively with psql \password, never in argv.
-- Roles are deliberately created without a default/login password.
CREATE ROLE fair_owner_runtime LOGIN;
CREATE ROLE fair_backup LOGIN;
REVOKE ALL ON DATABASE fair_staging FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE fair_staging TO fair_owner_runtime, fair_backup;
GRANT USAGE ON SCHEMA public TO fair_owner_runtime, fair_backup;
GRANT SELECT (id, source_instance_id, received_at, processing_status) ON pasarguard_webhook_batches TO fair_owner_runtime;
GRANT SELECT (id, source_instance_id, created_at, source_enqueued_at, action, external_user_id, user_status, data_limit_bytes, first_seen_at, event_status, billing_admin_id, actor_admin_id, actor_admin_username, occurrence_count) ON pasarguard_events TO fair_owner_runtime;
GRANT SELECT (id, batch_id, batch_index, issue_code, created_at, resolved_at) ON pasarguard_ingestion_issues TO fair_owner_runtime;
-- FP-005 reuses this server-only role for the encrypted inbound processor.
-- It must read ciphertext and normalized identifiers, but UPDATE is restricted
-- to retry/receipt metadata; core event content cannot be rewritten by it.
GRANT SELECT,INSERT ON pasarguard_webhook_batches,pasarguard_events,pasarguard_ingestion_issues TO fair_owner_runtime;
GRANT UPDATE (processing_status,processing_attempts,last_processing_at,last_error_code,
  last_error_message,updated_at,raw_payload_ciphertext,raw_payload_iv,
  raw_payload_auth_tag,raw_payload_key_version,raw_payload_purged_at)
  ON pasarguard_webhook_batches TO fair_owner_runtime;
GRANT UPDATE (occurrence_count,event_status,first_seen_at,last_seen_at,updated_at)
  ON pasarguard_events TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_shadow_days,fair_shadow_items,fair_shadow_late_events TO fair_owner_runtime;
-- Opening baseline is staging SHADOW evidence, not a financial ledger write.
GRANT SELECT,INSERT,UPDATE ON fair_opening_baseline_runs,fair_opening_baseline_users TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_opening_baseline_runs_id_seq TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_shadow_days_id_seq,pasarguard_webhook_batches_id_seq,
  pasarguard_events_id_seq,pasarguard_ingestion_issues_id_seq TO fair_owner_runtime;
GRANT SELECT ON fair_owner TO fair_owner_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fair_owner_sessions, fair_owner_login_budget TO fair_owner_runtime;
GRANT INSERT, DELETE ON fair_owner_audit TO fair_owner_runtime;
GRANT SELECT (created_at) ON fair_owner_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_owner_audit_id_seq TO fair_owner_runtime;
GRANT SELECT, INSERT ON fair_pricing_plans, fair_pricing_rule_versions, fair_pricing_fixed_packages, fair_pricing_assignments TO fair_owner_runtime;
GRANT INSERT ON fair_pricing_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_pricing_plans_id_seq, fair_pricing_rule_versions_id_seq, fair_pricing_assignments_id_seq, fair_pricing_audit_id_seq TO fair_owner_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fair_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO fair_backup;

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
GRANT SELECT ON fair_owner TO fair_owner_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fair_owner_sessions, fair_owner_login_budget TO fair_owner_runtime;
GRANT INSERT, DELETE ON fair_owner_audit TO fair_owner_runtime;
GRANT SELECT (created_at) ON fair_owner_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_owner_audit_id_seq TO fair_owner_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fair_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO fair_backup;

-- Run once, after reviewed migrations, with fair_migrator on a *fresh* DB.
-- Restricted runtime and read-only dump roles; credentials are installed
-- through the operator-only provisioning script, never in source control.
CREATE ROLE fair_owner_runtime LOGIN;
CREATE ROLE fair_backup LOGIN;
REVOKE ALL ON DATABASE fair_platform FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE fair_platform TO fair_owner_runtime, fair_backup;
GRANT USAGE ON SCHEMA public TO fair_owner_runtime, fair_backup;
GRANT SELECT (id, source_instance_id, received_at, processing_status) ON pasarguard_webhook_batches TO fair_owner_runtime;
GRANT SELECT (id, source_instance_id, created_at, source_enqueued_at, action, external_user_id, user_status, data_limit_bytes, first_seen_at, event_status, billing_admin_id, actor_admin_id, actor_admin_username, occurrence_count) ON pasarguard_events TO fair_owner_runtime;
GRANT SELECT (id,source_instance_id,action,external_user_id,username,
  billing_admin_id,billing_admin_username,actor_admin_id,actor_admin_username,
  source_enqueued_at,data_limit_bytes,on_hold_expire_duration_seconds,
  source_user_created_at,source_user_expire_at,
  user_status,event_status) ON pasarguard_events TO fair_owner_runtime;
GRANT SELECT (id, batch_id, batch_index, issue_code, created_at, resolved_at) ON pasarguard_ingestion_issues TO fair_owner_runtime;
GRANT SELECT,INSERT ON pasarguard_webhook_batches,pasarguard_events,pasarguard_ingestion_issues TO fair_owner_runtime;
GRANT UPDATE (processing_status,processing_attempts,last_processing_at,last_error_code,
  last_error_message,updated_at,raw_payload_ciphertext,raw_payload_iv,
  raw_payload_auth_tag,raw_payload_key_version,raw_payload_purged_at)
  ON pasarguard_webhook_batches TO fair_owner_runtime;
GRANT UPDATE (occurrence_count,event_status,first_seen_at,last_seen_at,updated_at)
  ON pasarguard_events TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_shadow_days,fair_shadow_items,fair_shadow_late_events TO fair_owner_runtime;
GRANT SELECT ON fair_shadow_day_reports TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_shadow_reviews,fair_shadow_review_events TO fair_owner_runtime;
GRANT SELECT,INSERT,UPDATE (status,catalog_hash,event_count,ignored_count,
  entry_count,held_count,held_candidate_count,failure_code,finished_at)
  ON fair_replay_shadow_runs TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_replay_shadow_days,fair_replay_shadow_entries,
  fair_replay_shadow_holds TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_replay_shadow_runs_id_seq TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_replay_shadow_audit_prices,
  fair_replay_shadow_held_candidates,fair_replay_shadow_ignored_summary TO fair_owner_runtime;
GRANT SELECT ON fair_replay_private_identity_imports,
  fair_replay_private_identity_aliases TO fair_owner_runtime;
GRANT SELECT ON fair_replay_archives,fair_replay_shadow_manual_reviews TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_replay_shadow_manual_operations TO fair_owner_runtime;
GRANT EXECUTE ON FUNCTION fair_replay_copy_manual_reviews(bigint,bigint) TO fair_owner_runtime;
GRANT SELECT,INSERT,UPDATE ON fair_opening_baseline_runs,fair_opening_baseline_users TO fair_owner_runtime;
GRANT SELECT,INSERT,UPDATE (current_run_id,generation,changed_at)
  ON fair_opening_baseline_control TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_opening_baseline_reseed_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_opening_baseline_reseed_audit_id_seq TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_opening_baseline_runs_id_seq TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_shadow_days_id_seq,pasarguard_webhook_batches_id_seq,
  pasarguard_events_id_seq,pasarguard_ingestion_issues_id_seq TO fair_owner_runtime;
GRANT SELECT ON fair_owner TO fair_owner_runtime;
GRANT UPDATE (password_hash) ON fair_owner TO fair_owner_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fair_owner_sessions, fair_owner_login_budget TO fair_owner_runtime;
GRANT INSERT, DELETE ON fair_owner_audit TO fair_owner_runtime;
GRANT SELECT (created_at) ON fair_owner_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_owner_audit_id_seq TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_admin_groups TO fair_owner_runtime;
GRANT SELECT,INSERT,UPDATE ON fair_admin_group_memberships,fair_atomic_packages,fair_tariff_assignments TO fair_owner_runtime;
GRANT DELETE ON fair_admin_group_memberships TO fair_owner_runtime;
GRANT SELECT,INSERT ON fair_admin_group_membership_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_admin_groups_id_seq,fair_admin_group_membership_audit_id_seq,
  fair_atomic_packages_id_seq,fair_tariff_assignments_id_seq TO fair_owner_runtime;
GRANT SELECT, INSERT ON fair_pricing_plans, fair_pricing_rule_versions, fair_pricing_fixed_packages, fair_pricing_assignments TO fair_owner_runtime;
GRANT INSERT ON fair_pricing_audit TO fair_owner_runtime;
GRANT USAGE ON SEQUENCE fair_pricing_plans_id_seq, fair_pricing_rule_versions_id_seq, fair_pricing_assignments_id_seq, fair_pricing_audit_id_seq TO fair_owner_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fair_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO fair_backup;

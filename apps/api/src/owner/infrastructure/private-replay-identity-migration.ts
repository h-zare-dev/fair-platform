import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Source-attested historical display metadata; never a ledger or identity authority for primary. */
export class PrivateReplayIdentity1792100000000 implements MigrationInterface {
  name = 'PrivateReplayIdentity1792100000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_replay_private_identity_imports (
      source_instance_id varchar(32) PRIMARY KEY CHECK(source_instance_id='replay-30d'),
      manifest_sha256 char(64) NOT NULL,
      map_sha256 char(64) NOT NULL,
      replay_plaintext_sha256 char(64) NOT NULL,
      source_script_sha256 char(64) NOT NULL,
      event_count integer NOT NULL CHECK(event_count=64135),
      mapped_admins integer NOT NULL CHECK(mapped_admins BETWEEN 0 AND 1000),
      mapped_accounts integer NOT NULL CHECK(mapped_accounts BETWEEN 0 AND 100000),
      mapped_actor_admins integer NOT NULL CHECK(mapped_actor_admins BETWEEN 0 AND 1000),
      unmatched_admin_pairs integer NOT NULL CHECK(unmatched_admin_pairs >= 0),
      unmatched_account_pairs integer NOT NULL CHECK(unmatched_account_pairs >= 0),
      unmatched_actor_pairs integer NOT NULL CHECK(unmatched_actor_pairs >= 0),
      imported_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(`CREATE TABLE fair_replay_private_identity_aliases (
      source_instance_id varchar(32) NOT NULL REFERENCES fair_replay_private_identity_imports(source_instance_id),
      role varchar(16) NOT NULL CHECK(role IN ('billing_admin','actor_admin','account')),
      archived_id bigint NOT NULL,
      archived_username text NOT NULL,
      original_id bigint NOT NULL,
      original_username text,
      PRIMARY KEY(source_instance_id,role,archived_id,archived_username),
      CHECK(length(archived_username)<=255),
      CHECK(original_username IS NULL OR length(original_username)<=255)
    )`);
    await r.query(`CREATE INDEX fair_replay_identity_lookup ON fair_replay_private_identity_aliases
      (source_instance_id,role,archived_id)`);
    for (const table of [
      'fair_replay_private_identity_imports',
      'fair_replay_private_identity_aliases',
    ]) {
      await r.query(`CREATE TRIGGER replay_private_identity_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION fair_replay_shadow_evidence_immutable()`);
    }
    // Only private CLI has INSERT grants via migration owner; Owner API is read-only.
    await r.query(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT ON fair_replay_private_identity_imports,
        fair_replay_private_identity_aliases TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query('DROP TABLE fair_replay_private_identity_aliases');
    await r.query('DROP TABLE fair_replay_private_identity_imports');
  }
}

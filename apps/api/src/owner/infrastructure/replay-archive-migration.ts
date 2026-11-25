import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReplayArchive1792200000000 implements MigrationInterface {
  name = 'ReplayArchive1792200000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE fair_replay_archives (
      source_instance_id varchar(100) PRIMARY KEY
        CHECK (source_instance_id ~ '^replay-archive-[a-f0-9]{64}$'),
      starts_at timestamptz NOT NULL,
      cutoff_at timestamptz NOT NULL CHECK (cutoff_at > starts_at),
      batch_count integer NOT NULL CHECK (batch_count BETWEEN 1 AND 100000),
      expected_children integer NOT NULL CHECK (expected_children BETWEEN 1 AND 400000),
      imported_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(`CREATE TRIGGER replay_archive_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON fair_replay_archives
      FOR EACH STATEMENT EXECUTE FUNCTION fair_replay_shadow_evidence_immutable()`);
    await r.query(`ALTER TABLE fair_replay_shadow_runs
      DROP CONSTRAINT fair_replay_shadow_runs_source_instance_id_check,
      ADD CONSTRAINT fair_replay_shadow_runs_source_instance_id_check
        CHECK (source_instance_id='replay-30d' OR
               source_instance_id ~ '^replay-archive-[a-f0-9]{64}$')`);
    await r.query(`CREATE INDEX replay_shadow_renewal_review
      ON fair_replay_shadow_entries(run_id,billing_admin_id,external_user_id,local_day,occurred_at)
      WHERE kind='RENEWAL'`);
    await r.query(`CREATE TABLE fair_replay_shadow_manual_reviews (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      review_key char(64) NOT NULL CHECK (review_key ~ '^[a-f0-9]{64}$'),
      PRIMARY KEY (run_id,review_key)
    )`);
    await r.query(`CREATE TABLE fair_replay_shadow_manual_operations (
      run_id bigint NOT NULL REFERENCES fair_replay_shadow_runs(id),
      operation_key varchar(128) NOT NULL,
      reason_code varchar(64) NOT NULL,
      review_key char(64) NOT NULL,
      billing_admin_id bigint NOT NULL,
      external_user_id bigint NOT NULL,
      local_day varchar(10) NOT NULL,
      occurred_at timestamptz NOT NULL,
      source_event_ids bigint[] NOT NULL,
      PRIMARY KEY (run_id,operation_key),
      FOREIGN KEY (run_id,review_key) REFERENCES fair_replay_shadow_manual_reviews(run_id,review_key)
    )`);
    for (const table of [
      'fair_replay_shadow_manual_reviews',
      'fair_replay_shadow_manual_operations',
    ])
      await r.query(`CREATE TRIGGER replay_manual_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION fair_replay_shadow_evidence_immutable()`);
    // HTTP reruns may reuse approvals; only the privileged import CLI can
    // supply new keys. Never grant the runtime direct INSERT on approvals.
    await r.query(`CREATE FUNCTION fair_replay_copy_manual_reviews(
      previous_run bigint, target_run bigint
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM public.fair_replay_shadow_runs prior
        JOIN public.fair_replay_shadow_runs target
          ON target.source_instance_id=prior.source_instance_id
        WHERE prior.id=previous_run AND prior.status IN ('COMPLETE','FAILED')
          AND target.id=target_run AND target.status='PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM public.fair_replay_shadow_manual_reviews WHERE run_id=target_run
          )
      ) THEN
        RAISE EXCEPTION 'REPLAY_MANUAL_REVIEW_COPY_INVALID';
      END IF;
      INSERT INTO public.fair_replay_shadow_manual_reviews(run_id,review_key)
      SELECT target_run, review_key FROM public.fair_replay_shadow_manual_reviews
      WHERE run_id=previous_run;
    END $$`);
    await r.query(
      `REVOKE ALL ON FUNCTION fair_replay_copy_manual_reviews(bigint,bigint) FROM PUBLIC`,
    );
    await r.query(`DO $$ BEGIN IF EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname='fair_owner_runtime') THEN
      GRANT SELECT ON fair_replay_archives,fair_replay_shadow_manual_reviews TO fair_owner_runtime;
      GRANT SELECT,INSERT ON fair_replay_shadow_manual_operations TO fair_owner_runtime;
      GRANT EXECUTE ON FUNCTION fair_replay_copy_manual_reviews(bigint,bigint) TO fair_owner_runtime;
    END IF; END $$`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query(`ALTER TABLE fair_replay_shadow_runs
      DROP CONSTRAINT fair_replay_shadow_runs_source_instance_id_check,
      ADD CONSTRAINT fair_replay_shadow_runs_source_instance_id_check
        CHECK (source_instance_id='replay-30d')`);
    await r.query(
      'DROP FUNCTION fair_replay_copy_manual_reviews(bigint,bigint)',
    );
    await r.query('DROP INDEX replay_shadow_renewal_review');
    await r.query('DROP TABLE fair_replay_shadow_manual_operations');
    await r.query('DROP TABLE fair_replay_shadow_manual_reviews');
    await r.query('DROP TABLE fair_replay_archives');
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ReplaySourceIdentity1792500000000 implements MigrationInterface {
  name = 'ReplaySourceIdentity1792500000000';

  async up(r: QueryRunner): Promise<void> {
    await r.query(`ALTER TABLE fair_replay_archives
      ADD COLUMN source_identity boolean NOT NULL DEFAULT false`);
  }

  async down(r: QueryRunner): Promise<void> {
    await r.query(
      `ALTER TABLE fair_replay_archives DROP COLUMN source_identity`,
    );
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Global time indexes justified by PostgreSQL 17 plans on 120k synthetic rows.
 * Source-leading indexes remain useful when an explicit source is selected.
 */
export class OwnerGlobalTimeIndexes1791100000000 implements MigrationInterface {
  name = 'OwnerGlobalTimeIndexes1791100000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE INDEX owner_batches_all_window ON pasarguard_webhook_batches (received_at)',
    );
    await runner.query(
      'CREATE INDEX owner_events_all_created ON pasarguard_events (created_at)',
    );
    await runner.query(
      'CREATE INDEX owner_events_all_source_time ON pasarguard_events (source_enqueued_at DESC, id DESC)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    for (const index of [
      'owner_batches_all_window',
      'owner_events_all_created',
      'owner_events_all_source_time',
    ])
      await runner.query(`DROP INDEX ${index}`);
  }
}

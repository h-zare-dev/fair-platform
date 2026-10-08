import type { DataSource, EntityManager } from 'typeorm';
import { children } from '../schemas/envelope.js';
import { normalize } from '../normalization/normalize.js';
import {
  BatchEntity,
  EventEntity,
  IssueEntity,
  type BatchRow,
} from './entities.js';
import { PayloadEncryption } from './encryption.js';

export class BatchProcessor {
  constructor(
    private readonly database: DataSource,
    private readonly encryption: PayloadEncryption,
    private readonly maxAttempts: number,
  ) {}

  async processNext(): Promise<boolean> {
    return this.database.transaction(async (manager) => {
      const batch = await manager
        .getRepository(BatchEntity)
        .createQueryBuilder('batch')
        .where('batch.processing_status IN (:...states)', {
          states: ['RECEIVED', 'FAILED_RETRYABLE'],
        })
        .orderBy('batch.received_at', 'ASC')
        .addOrderBy('batch.id', 'ASC')
        .limit(1)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!batch) return false;
      const attempts = batch.processing_attempts + 1;
      const now = new Date();
      await manager.update(BatchEntity, batch.id, {
        processing_status: 'NORMALIZING',
        processing_attempts: attempts,
        last_processing_at: now,
        updated_at: now,
      });
      // PostgreSQL savepoint preserves the claim/attempt while rolling back every child write on failure.
      await manager.query('SAVEPOINT normalize_batch');
      try {
        const payload = this.decrypt(batch);
        for (const [index, child] of children(payload).entries()) {
          const result = normalize(child, batch.source_instance_id);
          for (const issue of result.issues)
            await this.issue(
              manager,
              batch.id,
              index,
              issue.code,
              issue.message,
            );
          if (!result.event) continue;
          const event = result.event;
          const inserted = await manager
            .createQueryBuilder()
            .insert()
            .into(EventEntity)
            .values({
              ...event,
              batch_id: batch.id,
              batch_index: index,
              first_seen_at: batch.received_at,
              last_seen_at: batch.received_at,
              // Date conversion would discard sub-millisecond source precision.
              source_enqueued_at: () => 'CAST(:enqueued AS timestamptz)',
              source_send_at: () => 'CAST(:sent AS timestamptz)',
            })
            .setParameters({
              enqueued: event.source_enqueued_at,
              sent: event.source_send_at,
            })
            .orIgnore()
            .returning('id')
            .execute();
          if ((inserted.raw as unknown[]).length === 0) {
            await manager
              .createQueryBuilder()
              .update(EventEntity)
              .set({
                occurrence_count: () => 'occurrence_count + 1',
                event_status: () =>
                  "CASE WHEN :incomingStatus = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE event_status END",
                first_seen_at: () => 'LEAST(first_seen_at, :receipt)',
                last_seen_at: () => 'GREATEST(last_seen_at, :receipt)',
                updated_at: now,
              })
              .where(
                'source_instance_id = :source AND semantic_fingerprint = :fingerprint',
                {
                  source: event.source_instance_id,
                  fingerprint: event.semantic_fingerprint,
                  receipt: batch.received_at,
                  incomingStatus: event.event_status,
                },
              )
              .execute();
            await this.issue(
              manager,
              batch.id,
              index,
              'DUPLICATE_EVENT',
              'Logical event already exists',
            );
          }
        }
        await manager.update(BatchEntity, batch.id, {
          processing_status: 'NORMALIZED',
          last_error_code: null,
          last_error_message: null,
          updated_at: new Date(),
        });
      } catch {
        await manager.query('ROLLBACK TO SAVEPOINT normalize_batch');
        await manager.update(BatchEntity, batch.id, {
          processing_status:
            attempts >= this.maxAttempts
              ? 'FAILED_PERMANENT'
              : 'FAILED_RETRYABLE',
          last_error_code: 'NORMALIZATION_FAILED',
          last_error_message: 'Batch normalization failed',
          updated_at: new Date(),
        });
        if (attempts >= this.maxAttempts)
          await this.issue(
            manager,
            batch.id,
            null,
            'NORMALIZATION_FAILED',
            'Batch exhausted normalization attempts',
          );
      }
      return true;
    });
  }

  private decrypt(batch: BatchRow): unknown {
    if (
      !batch.raw_payload_ciphertext ||
      !batch.raw_payload_iv ||
      !batch.raw_payload_auth_tag ||
      batch.raw_payload_key_version === null
    ) {
      throw new Error('RAW_PAYLOAD_UNAVAILABLE');
    }
    return this.encryption.decrypt({
      ciphertext: batch.raw_payload_ciphertext,
      iv: batch.raw_payload_iv,
      authTag: batch.raw_payload_auth_tag,
      keyVersion: batch.raw_payload_key_version,
    });
  }
  private async issue(
    manager: EntityManager,
    batch: string,
    index: number | null,
    code: string,
    message: string,
  ): Promise<void> {
    await manager.insert(IssueEntity, {
      batch_id: batch,
      batch_index: index,
      issue_code: code,
      issue_message: message,
    });
  }
}

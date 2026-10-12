import type { DataSource, EntityManager } from 'typeorm';
import {
  AccountingError,
  validateAccountingException,
  validateShadowCharge,
  type AccountingExceptionInput,
  type Charge,
  type ShadowChargeInput,
} from '../domain/contracts.js';
import type {
  AccountingExceptions,
  RecordedCharge,
  RecordedException,
  RecordingResult,
  ShadowLedger,
} from '../application/ports.js';
import {
  ExceptionEntity,
  LinkEntity,
  TransactionEntity,
  type ExceptionRow,
  type TransactionRow,
} from './entities.js';

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Each operation owns one READ COMMITTED transaction. Unique insertion waits for racing writers;
 * a subsequent statement sees the winning committed row and its complete immutable event set.
 */
export class PostgresAccountingStore
  implements ShadowLedger, AccountingExceptions
{
  constructor(private readonly database: DataSource) {}

  async recordShadowCharge(
    input: ShadowChargeInput,
  ): Promise<RecordingResult<RecordedCharge>> {
    const charge = validateShadowCharge(input);
    return this.safely(() =>
      this.database.transaction('READ COMMITTED', async (manager) => {
        // TypeORM timestamp insertion converts strings to Date and loses microseconds.
        // Parameterized PostgreSQL INSERT preserves precision and targets only the scoped key.
        const ids = await manager.query<{ id: string }[]>(
          `INSERT INTO accounting_transactions
            (source_instance_id, operation_key, posting_scope, entry_type, billing_admin_id,
             external_user_id, amount_toman, occurred_at, reason_code)
           VALUES ($1, $2, 'SHADOW', 'CHARGE', $3, $4, $5, $6::timestamptz, $7)
           ON CONFLICT (source_instance_id, posting_scope, operation_key) DO NOTHING RETURNING id`,
          [
            charge.sourceInstanceId,
            charge.operationKey,
            charge.billingAdminId,
            charge.externalUserId,
            charge.amountToman,
            charge.occurredAt,
            charge.reasonCode,
          ],
        );
        if (ids.length) {
          await this.verifyEvents(
            manager,
            charge.sourceInstanceId,
            charge.externalUserId,
            charge.eventIds,
          );
          await manager
            .createQueryBuilder()
            .insert()
            .into(LinkEntity)
            .values(
              charge.eventIds.map((eventId) => ({
                transaction_id: ids[0]!.id,
                event_id: eventId,
              })),
            )
            .execute();
        }
        const row = await manager
          .createQueryBuilder()
          .select('t.*')
          .from(TransactionEntity, 't')
          .addSelect(utc('t.occurred_at'), 'occurred_at')
          .addSelect(utc('t.recorded_at'), 'recorded_at')
          .where(
            't.source_instance_id = :source AND t.posting_scope = :scope AND t.operation_key = :key',
            {
              source: charge.sourceInstanceId,
              scope: 'SHADOW',
              key: charge.operationKey,
            },
          )
          .getRawOne<TransactionRow>();
        if (!row) throw new AccountingError('ACCOUNTING_PERSISTENCE_FAILED');
        const links = await manager
          .getRepository(LinkEntity)
          .findBy({ transaction_id: row.id });
        const record: RecordedCharge = Object.freeze({
          id: row.id,
          sourceInstanceId: row.source_instance_id,
          operationKey: row.operation_key,
          postingScope: row.posting_scope,
          entryType: row.entry_type,
          billingAdminId: row.billing_admin_id,
          externalUserId: row.external_user_id,
          amountToman: row.amount_toman,
          occurredAt: row.occurred_at,
          recordedAt: row.recorded_at,
          reasonCode: row.reason_code,
          eventIds: Object.freeze(
            links
              .map((link) => link.event_id)
              .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
          ),
        });
        if (!sameCharge(charge, record))
          throw new AccountingError('FINANCIAL_IDEMPOTENCY_CONFLICT');
        return {
          outcome: ids.length ? 'RECORDED' : 'ALREADY_RECORDED',
          record,
        };
      }),
    );
  }

  async recordAccountingException(
    input: AccountingExceptionInput,
  ): Promise<RecordingResult<RecordedException>> {
    const exception = validateAccountingException(input);
    return this.safely(() =>
      this.database.transaction('READ COMMITTED', async (manager) => {
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(ExceptionEntity)
          .values({
            source_instance_id: exception.sourceInstanceId,
            exception_key: exception.exceptionKey,
            exception_code: exception.exceptionCode,
            event_id: exception.eventId,
            external_user_id: exception.externalUserId,
            billing_admin_id: exception.billingAdminId,
            message: exception.message,
            status: 'OPEN',
          })
          .orIgnore()
          .returning('id')
          .execute();
        const ids = inserted.raw as { id: string }[];
        if (ids.length && exception.eventId !== null) {
          await this.verifyEvents(
            manager,
            exception.sourceInstanceId,
            exception.externalUserId,
            [exception.eventId],
          );
        }
        const row = await manager
          .createQueryBuilder()
          .select('e.*')
          .from(ExceptionEntity, 'e')
          .addSelect(utc('e.created_at'), 'created_at')
          .where('e.source_instance_id = :source AND e.exception_key = :key', {
            source: exception.sourceInstanceId,
            key: exception.exceptionKey,
          })
          .getRawOne<ExceptionRow>();
        if (!row) throw new AccountingError('ACCOUNTING_PERSISTENCE_FAILED');
        if (
          row.exception_code !== exception.exceptionCode ||
          row.event_id !== exception.eventId ||
          row.external_user_id !== exception.externalUserId ||
          row.billing_admin_id !== exception.billingAdminId
        ) {
          throw new AccountingError('ACCOUNTING_EXCEPTION_CONFLICT');
        }
        return {
          outcome: ids.length ? 'RECORDED' : 'ALREADY_RECORDED',
          record: Object.freeze({
            ...exception,
            id: row.id,
            createdAt: row.created_at,
          }),
        };
      }),
    );
  }

  private async verifyEvents(
    manager: EntityManager,
    source: string,
    user: string | null,
    ids: readonly string[],
  ): Promise<void> {
    // No dependency on the Pasarguard package; this query uses its established shared DB schema.
    const events = await manager
      .createQueryBuilder()
      .select([
        'event.id AS id',
        'event.source_instance_id AS source',
        'event.external_user_id AS user',
      ])
      .from('pasarguard_events', 'event')
      .where('event.id IN (:...ids)', { ids })
      .setLock('pessimistic_read')
      .getRawMany<{ id: string; source: string; user: string }>();
    if (
      events.length !== ids.length ||
      events.some(
        (event) =>
          event.source !== source || (user !== null && event.user !== user),
      )
    ) {
      throw new AccountingError('INVALID_SOURCE_REFERENCE');
    }
  }
  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccountingError) throw error;
      throw new AccountingError('ACCOUNTING_PERSISTENCE_FAILED');
    }
  }
}
function sameCharge(a: Charge, b: Charge): boolean {
  return (
    a.sourceInstanceId === b.sourceInstanceId &&
    a.operationKey === b.operationKey &&
    a.postingScope === b.postingScope &&
    a.entryType === b.entryType &&
    a.billingAdminId === b.billingAdminId &&
    a.externalUserId === b.externalUserId &&
    a.amountToman === b.amountToman &&
    a.occurredAt === b.occurredAt &&
    a.reasonCode === b.reasonCode &&
    a.eventIds.length === b.eventIds.length &&
    a.eventIds.every((id, index) => id === b.eventIds[index])
  );
}

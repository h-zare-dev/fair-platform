import { EntitySchema } from 'typeorm';
import type { ExceptionCode } from '../domain/contracts.js';
export interface TransactionRow {
  id: string;
  source_instance_id: string;
  operation_key: string;
  posting_scope: 'SHADOW';
  entry_type: 'CHARGE';
  billing_admin_id: string;
  external_user_id: string;
  amount_toman: string;
  occurred_at: string;
  recorded_at: string;
  reason_code: string;
}
export interface LinkRow {
  transaction_id: string;
  event_id: string;
}
export interface ExceptionRow {
  id: string;
  source_instance_id: string;
  exception_key: string;
  exception_code: ExceptionCode;
  event_id: string | null;
  external_user_id: string | null;
  billing_admin_id: string | null;
  message: string;
  status: 'OPEN';
  created_at: string;
}
export const TransactionEntity = new EntitySchema<TransactionRow>({
  name: 'accounting_transactions',
  tableName: 'accounting_transactions',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    source_instance_id: { type: 'varchar', length: 100 },
    operation_key: { type: 'varchar', length: 128 },
    posting_scope: { type: 'varchar', length: 16 },
    entry_type: { type: 'varchar', length: 32 },
    billing_admin_id: { type: 'bigint' },
    external_user_id: { type: 'bigint' },
    amount_toman: { type: 'bigint' },
    occurred_at: { type: 'timestamptz' },
    recorded_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
    reason_code: { type: 'varchar', length: 64 },
  },
});
export const LinkEntity = new EntitySchema<LinkRow>({
  name: 'accounting_transaction_events',
  tableName: 'accounting_transaction_events',
  columns: {
    transaction_id: { type: 'bigint', primary: true },
    event_id: { type: 'bigint', primary: true },
  },
});
export const ExceptionEntity = new EntitySchema<ExceptionRow>({
  name: 'accounting_exceptions',
  tableName: 'accounting_exceptions',
  columns: {
    id: { type: 'bigint', primary: true, generated: 'increment' },
    source_instance_id: { type: 'varchar', length: 100 },
    exception_key: { type: 'varchar', length: 128 },
    exception_code: { type: 'varchar', length: 64 },
    event_id: { type: 'bigint', nullable: true },
    external_user_id: { type: 'bigint', nullable: true },
    billing_admin_id: { type: 'bigint', nullable: true },
    message: { type: 'varchar', length: 128 },
    status: { type: 'varchar', length: 16 },
    created_at: { type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' },
  },
});

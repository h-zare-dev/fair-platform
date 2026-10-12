export type AccountingErrorCode =
  | 'INVALID_ACCOUNTING_INPUT'
  | 'INVALID_SOURCE_REFERENCE'
  | 'FINANCIAL_IDEMPOTENCY_CONFLICT'
  | 'ACCOUNTING_EXCEPTION_CONFLICT'
  | 'ACCOUNTING_PERSISTENCE_FAILED';

/** Fixed codes only: driver errors and caller values never become public messages. */
export class AccountingError extends Error {
  constructor(public readonly code: AccountingErrorCode) {
    super(code);
    this.name = 'AccountingError';
  }
}
export const exceptionMessages = {
  PRICING_MISSING: 'Required pricing is missing',
  UNEXPECTED_UNLIMITED: 'Unlimited state requires review',
  PREVIOUS_STATE_MISSING: 'Previous state is missing',
  AMBIGUOUS_CORRELATION: 'Event correlation requires review',
  UNKNOWN_WEBHOOK_EVENT: 'Webhook event requires review',
} as const;
export type ExceptionCode = keyof typeof exceptionMessages;
export type IntegerInput = string | bigint;
export interface ShadowChargeInput {
  sourceInstanceId: string;
  operationKey: string;
  billingAdminId: IntegerInput;
  externalUserId: IntegerInput;
  amountToman: IntegerInput;
  occurredAt: string;
  reasonCode: string;
  eventIds: readonly IntegerInput[];
}
export interface Charge {
  readonly sourceInstanceId: string;
  readonly operationKey: string;
  readonly postingScope: 'SHADOW';
  readonly entryType: 'CHARGE';
  readonly billingAdminId: string;
  readonly externalUserId: string;
  readonly amountToman: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
  readonly eventIds: readonly string[];
}
export interface AccountingExceptionInput {
  sourceInstanceId: string;
  exceptionKey: string;
  exceptionCode: ExceptionCode;
  eventId?: IntegerInput | null;
  externalUserId?: IntegerInput | null;
  billingAdminId?: IntegerInput | null;
}
export interface AccountingException {
  readonly sourceInstanceId: string;
  readonly exceptionKey: string;
  readonly exceptionCode: ExceptionCode;
  readonly eventId: string | null;
  readonly externalUserId: string | null;
  readonly billingAdminId: string | null;
  readonly message: string;
  readonly status: 'OPEN';
}
const maximum = 9223372036854775807n;
function invalid(): never {
  throw new AccountingError('INVALID_ACCOUNTING_INPUT');
}
/** Numbers are excluded: callers must supply integer-safe values. */
export function integer(value: unknown, positive = false): string {
  if (typeof value !== 'string' && typeof value !== 'bigint') invalid();
  const text = String(value);
  if (
    text.trim() !== text ||
    !/^(0|[1-9][0-9]*)$/.test(text) ||
    text.length > 19
  )
    invalid();
  const parsed = BigInt(text);
  if (parsed > maximum || (positive && parsed === 0n)) invalid();
  return text;
}
function identity(value: unknown, limit: number): string {
  // Opaque caller-owned token; no normalization or identity inference.
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
  )
    invalid();
  return value;
}
/** UTC ISO input at PostgreSQL microsecond precision; reject rather than round. */
export function timestamp(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    value,
  );
  if (!match || match[0] !== value) invalid();
  const base = match[1]!;
  const date = new Date(`${base}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== base ||
    base.startsWith('0000')
  )
    invalid();
  return `${base}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}
export function validateShadowCharge(input: ShadowChargeInput): Charge {
  if (!input || typeof input !== 'object') invalid();
  if (!Array.isArray(input.eventIds) || input.eventIds.length === 0) invalid();
  const eventIds = [
    ...new Set(Array.from(input.eventIds, (id: unknown) => integer(id, true))),
  ];
  eventIds.sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
  );
  return Object.freeze({
    sourceInstanceId: identity(input.sourceInstanceId, 100),
    operationKey: identity(input.operationKey, 128),
    postingScope: 'SHADOW',
    entryType: 'CHARGE',
    billingAdminId: integer(input.billingAdminId),
    externalUserId: integer(input.externalUserId),
    amountToman: integer(input.amountToman, true),
    occurredAt: timestamp(input.occurredAt),
    reasonCode: identity(input.reasonCode, 64),
    eventIds: Object.freeze(eventIds),
  });
}
export function validateAccountingException(
  input: AccountingExceptionInput,
): AccountingException {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.exceptionCode !== 'string' ||
    !Object.hasOwn(exceptionMessages, input.exceptionCode)
  )
    invalid();
  return Object.freeze({
    sourceInstanceId: identity(input.sourceInstanceId, 100),
    exceptionKey: identity(input.exceptionKey, 128),
    exceptionCode: input.exceptionCode,
    eventId: input.eventId == null ? null : integer(input.eventId, true),
    externalUserId:
      input.externalUserId == null ? null : integer(input.externalUserId),
    billingAdminId:
      input.billingAdminId == null ? null : integer(input.billingAdminId),
    message: exceptionMessages[input.exceptionCode],
    status: 'OPEN',
  });
}

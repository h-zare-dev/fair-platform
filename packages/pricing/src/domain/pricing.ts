/** FP-004 exact integer-Toman calculation. Framework and persistence independent. */
export const GIB_BYTES = 1_073_741_824n;
export const MAX_BIGINT = 9_223_372_036_854_775_807n;
export type PricingMode = 'PER_GIB' | 'FIXED' | 'MIXED';
export type PricingSource = 'ADMIN_OVERRIDE' | 'ASSIGNED_PLAN' | 'DEFAULT_PLAN';
export type PricingFailure =
  | 'INVALID_PRICING_INPUT'
  | 'PRICING_MISSING'
  | 'UNEXPECTED_UNLIMITED'
  | 'PRICING_CONFIG_CONFLICT'
  | 'PRICING_OVERFLOW';
export class PricingError extends Error {
  constructor(readonly code: PricingFailure) {
    super(code);
    this.name = 'PricingError';
  }
}
export type IntegerInput = string | bigint;
export interface PricingRule {
  readonly versionId: string;
  readonly source: PricingSource;
  readonly sourceInstanceId: string;
  readonly billingAdminId: string | null;
  readonly mode: PricingMode;
  readonly rateTomanPerGiB: IntegerInput | null;
  readonly fixedPackages: Readonly<Record<string, IntegerInput>>;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export interface PricingRequest {
  sourceInstanceId: string;
  billingAdminId: IntegerInput;
  occurredAt: string;
  billableBytes: IntegerInput;
  purpose: 'FULL_PACKAGE' | 'POSITIVE_DELTA';
  unlimited?: boolean | undefined;
}
export interface PricingQuote {
  amountToman: string;
  ruleVersionId: string;
  source: PricingSource;
  mode: PricingMode;
  sourceInstanceId: string;
  billingAdminId: string;
  occurredAt: string;
  billableBytes: string;
  purpose: PricingRequest['purpose'];
}
export function integer(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' && typeof value !== 'bigint')
    throw new PricingError('INVALID_PRICING_INPUT');
  const raw = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 19)
    throw new PricingError('INVALID_PRICING_INPUT');
  const amount = BigInt(raw);
  if (amount > MAX_BIGINT || (!allowZero && amount === 0n))
    throw new PricingError('INVALID_PRICING_INPUT');
  return amount;
}
export function utc(value: unknown): string {
  if (typeof value !== 'string')
    throw new PricingError('INVALID_PRICING_INPUT');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    value,
  );
  if (!match || match[1]!.startsWith('0000'))
    throw new PricingError('INVALID_PRICING_INPUT');
  const d = new Date(`${match[1]}Z`);
  if (
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 19) !== match[1]
  )
    throw new PricingError('INVALID_PRICING_INPUT');
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}
function sourceId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value)
  )
    throw new PricingError('INVALID_PRICING_INPUT');
  return value;
}
function validateRule(r: PricingRule): PricingRule {
  try {
    if (
      !/^[1-9][0-9]*$/.test(r.versionId) ||
      !['PER_GIB', 'FIXED', 'MIXED'].includes(r.mode)
    )
      throw Error();
    if (!['ADMIN_OVERRIDE', 'ASSIGNED_PLAN', 'DEFAULT_PLAN'].includes(r.source))
      throw Error();
    sourceId(r.sourceInstanceId);
    if (r.billingAdminId !== null) integer(r.billingAdminId, true);
    if (
      r.source === 'DEFAULT_PLAN'
        ? r.billingAdminId !== null
        : r.billingAdminId === null
    )
      throw Error();
    const start = utc(r.effectiveFrom);
    if (r.effectiveUntil !== null && utc(r.effectiveUntil) <= start)
      throw Error();
    if (r.mode === 'PER_GIB' && r.rateTomanPerGiB === null) throw Error();
    if (r.mode === 'FIXED' && r.rateTomanPerGiB !== null) throw Error();
    if (r.rateTomanPerGiB !== null) integer(r.rateTomanPerGiB);
    if (r.mode === 'PER_GIB' && Object.keys(r.fixedPackages).length)
      throw Error();
    for (const [bytes, amount] of Object.entries(r.fixedPackages)) {
      integer(bytes);
      integer(amount);
    }
  } catch {
    throw new PricingError('PRICING_CONFIG_CONFLICT');
  }
  return r;
}
/** Resolve one eligible tier; a missing fixed key never falls through to a cheaper plan. */
export function price(
  input: PricingRequest,
  rules: readonly PricingRule[],
): PricingQuote {
  if (input.unlimited === true) throw new PricingError('UNEXPECTED_UNLIMITED');
  if (input.unlimited !== undefined && input.unlimited !== false)
    throw new PricingError('INVALID_PRICING_INPUT');
  const source = sourceId(input.sourceInstanceId);
  const admin = String(integer(input.billingAdminId, true));
  const bytes = integer(input.billableBytes);
  const when = utc(input.occurredAt);
  if (input.purpose !== 'FULL_PACKAGE' && input.purpose !== 'POSITIVE_DELTA')
    throw new PricingError('INVALID_PRICING_INPUT');
  const active = rules
    .map(validateRule)
    .filter(
      (r) =>
        r.sourceInstanceId === source &&
        utc(r.effectiveFrom) <= when &&
        (r.effectiveUntil === null || when < utc(r.effectiveUntil)) &&
        (r.source === 'DEFAULT_PLAN' || r.billingAdminId === admin),
    );
  const selected = (
    ['ADMIN_OVERRIDE', 'ASSIGNED_PLAN', 'DEFAULT_PLAN'] as const
  )
    .map((level) => active.filter((r) => r.source === level))
    .find((tier) => tier.length);
  if (!selected) throw new PricingError('PRICING_MISSING');
  if (selected.length !== 1) throw new PricingError('PRICING_CONFIG_CONFLICT');
  const rule = selected[0]!;
  const fixed = rule.fixedPackages[String(bytes)];
  let amount: bigint;
  if (rule.mode !== 'PER_GIB' && fixed !== undefined) amount = integer(fixed);
  else if (rule.mode === 'FIXED' || rule.rateTomanPerGiB === null)
    throw new PricingError('PRICING_MISSING');
  else {
    const numerator = integer(rule.rateTomanPerGiB) * bytes;
    // Owner decision: CEIL the FINAL nonintegral Toman, never the traffic quantity.
    amount = numerator / GIB_BYTES + (numerator % GIB_BYTES === 0n ? 0n : 1n);
  }
  if (amount > MAX_BIGINT) throw new PricingError('PRICING_OVERFLOW');
  return Object.freeze({
    amountToman: String(amount),
    ruleVersionId: rule.versionId,
    source: rule.source,
    mode: rule.mode,
    sourceInstanceId: source,
    billingAdminId: admin,
    occurredAt: when,
    billableBytes: String(bytes),
    purpose: input.purpose,
  });
}

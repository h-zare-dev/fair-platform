import { z } from 'zod';
import { fingerprint } from '../fingerprinting/canonical.js';

export const actions = [
  'user_created',
  'user_updated',
  'user_deleted',
  'user_limited',
  'user_expired',
  'user_enabled',
  'user_disabled',
  'data_usage_reset',
  'subscription_revoked',
  'data_reset_by_next',
] as const;
const integer = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((value) => value >= 0);
// PostgreSQL character columns cannot represent NUL; reject it at the child boundary.
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\u0000'));
const admin = z.object({ id: integer, username: text(255) });
const sourceTime = z
  .number()
  .finite()
  .refine((value) => value >= -62135596800 && value < 253402300800);
const schema = z.object({
  action: text(64),
  enqueued_at: sourceTime,
  send_at: sourceTime.optional(),
  user: z.object({
    id: integer,
    username: text(255),
    status: text(64),
    admin,
    data_limit: integer,
    used_traffic: integer,
    lifetime_used_traffic: integer,
    data_limit_reset_strategy: text(64).nullish(),
    next_plan: z.unknown().optional(),
  }),
  by: admin.nullish(),
});
export type IssueCode =
  | 'INVALID_EVENT'
  | 'UNKNOWN_ACTION'
  | 'NORMALIZATION_FAILED'
  | 'INVALID_SOURCE_TIMESTAMP'
  | 'MISSING_REQUIRED_FIELD'
  | 'DUPLICATE_EVENT';
export interface SafeIssue {
  code: IssueCode;
  message: string;
}
export interface NormalizedEvent {
  source_instance_id: string;
  semantic_fingerprint: string;
  action: string;
  external_user_id: string;
  username: string;
  user_status: string;
  data_limit_bytes: string;
  used_traffic_bytes: string;
  lifetime_used_bytes: string;
  billing_admin_id: string;
  billing_admin_username: string;
  actor_admin_id: string | null;
  actor_admin_username: string | null;
  source_enqueued_at: string;
  source_send_at: string | null;
  reset_strategy: string | null;
  next_plan_data_limit_bytes: null;
  next_plan_expire: null;
  event_status: 'READY_FOR_ACCOUNTING' | 'NEEDS_REVIEW';
}

/** Convert source seconds at PostgreSQL microsecond precision without locale or Date rounding. */
export function sourceTimestamp(seconds: number): string {
  // Number.toString is the same decimal representation used by JSON/fingerprinting.
  // Expand its exponent before dividing so a tiny negative fraction cannot become -0.
  const [coefficient = '0', exponent = '0'] = Math.abs(seconds)
    .toString()
    .split('e');
  const [integerPart = '0', fractionalPart = ''] = coefficient.split('.');
  const decimalPlaces = fractionalPart.length - Number(exponent);
  const scale = Math.max(0, decimalPlaces);
  const denominator = 10n ** BigInt(scale);
  const magnitude =
    BigInt(integerPart + fractionalPart) *
    10n ** BigInt(Math.max(0, -decimalPlaces));
  const numerator = seconds < 0 ? -magnitude : magnitude;
  let whole = numerator / denominator;
  let remainder = numerator % denominator;
  // BigInt division truncates toward zero; timestamps need a floor and positive fraction.
  if (remainder < 0n) {
    whole -= 1n;
    remainder += denominator;
  }
  const scaledFraction = remainder * 1000000n;
  let microseconds = scaledFraction / denominator;
  const roundingRemainder = scaledFraction % denominator;
  // PostgreSQL rounds fractional seconds to the nearest microsecond, ties to even.
  if (
    roundingRemainder * 2n > denominator ||
    (roundingRemainder * 2n === denominator && microseconds % 2n !== 0n)
  ) {
    microseconds += 1n;
  }
  if (microseconds === 1000000n) {
    whole += 1n;
    microseconds = 0n;
  }
  const base = new Date(Number(whole) * 1000).toISOString().slice(0, 19);
  const fraction =
    microseconds === 0n
      ? ''
      : microseconds.toString().padStart(6, '0').replace(/0+$/, '');
  return `${base}${fraction ? `.${fraction}` : ''}Z`;
}

export function normalize(
  child: unknown,
  source: string,
): { event: NormalizedEvent | null; issues: SafeIssue[] } {
  const parsed = schema.safeParse(child);
  if (!parsed.success) {
    const timestamp = parsed.error.issues.some(
      (issue) => issue.path[0] === 'enqueued_at' || issue.path[0] === 'send_at',
    );
    const missing = parsed.error.issues.some(
      (issue) =>
        issue.code === 'invalid_type' && issue.message.includes('undefined'),
    );
    const code = timestamp
      ? 'INVALID_SOURCE_TIMESTAMP'
      : missing
        ? 'MISSING_REQUIRED_FIELD'
        : 'INVALID_EVENT';
    return {
      event: null,
      issues: [
        { code, message: 'Child event failed the approved field contract' },
      ],
    };
  }
  const input = parsed.data;
  if (!(actions as readonly string[]).includes(input.action)) {
    return {
      event: null,
      issues: [
        {
          code: 'UNKNOWN_ACTION',
          message: 'Unsupported child action requires review',
        },
      ],
    };
  }
  const user = input.user;
  const unverifiedPlan =
    user.next_plan !== undefined && user.next_plan !== null;
  const reset = user.data_limit_reset_strategy ?? null;
  const semantic = fingerprint({
    source,
    user: user.id,
    action: input.action,
    enqueued_at: input.enqueued_at,
    data_limit: user.data_limit,
    used_traffic: user.used_traffic,
    billing_admin: user.admin.id,
    status: user.status,
    reset_strategy: reset,
  });
  return {
    event: {
      source_instance_id: source,
      semantic_fingerprint: semantic,
      action: input.action,
      external_user_id: String(user.id),
      username: user.username,
      user_status: user.status,
      data_limit_bytes: String(user.data_limit),
      used_traffic_bytes: String(user.used_traffic),
      lifetime_used_bytes: String(user.lifetime_used_traffic),
      billing_admin_id: String(user.admin.id),
      billing_admin_username: user.admin.username,
      actor_admin_id: input.by ? String(input.by.id) : null,
      actor_admin_username: input.by?.username ?? null,
      source_enqueued_at: sourceTimestamp(input.enqueued_at),
      source_send_at:
        input.send_at === undefined ? null : sourceTimestamp(input.send_at),
      reset_strategy: reset,
      next_plan_data_limit_bytes: null,
      next_plan_expire: null,
      event_status: unverifiedPlan ? 'NEEDS_REVIEW' : 'READY_FOR_ACCOUNTING',
    },
    issues: unverifiedPlan
      ? [
          {
            code: 'INVALID_EVENT',
            message: 'Non-null next plan requires a verified source mapping',
          },
        ]
      : [],
  };
}

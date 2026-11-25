import type { DataSource, EntityManager } from 'typeorm';
import {
  jalaliValidityWindow,
  localJalaliDate,
  validateTimeZone,
} from '@fair-platform/calendar';

const GIB = 1073741824n;
const MAX_BIGINT = 9223372036854775807n;

interface CreateRow {
  id: string;
  source_instance_id: string;
  billing_admin_id: string;
  external_user_id: string;
  username: string;
  action: string;
  source_enqueued_at: Date;
  data_limit_bytes: string;
  on_hold_expire_duration_seconds: string | null;
  event_status: string;
}
interface Rule {
  id: string;
  target_kind: 'GROUP' | 'ADMIN';
  package_id: string | null;
  package_bytes: string | null;
  duration_days: number | null;
  amount_toman: string | null;
  rate_toman_per_gib: string | null;
}
interface Classified {
  reason: string | null;
  amount: string | null;
  packageId: string | null;
  assignmentId: string | null;
  durationDays: number | null;
}

/** No guessed duration, free trial, fallback rule, or partial money is posted. */
export function classifyCreate(
  bytesText: string,
  secondsText: string | null,
  rules: readonly Rule[],
  correction: boolean,
  sourceNeedsReview: boolean,
): Classified {
  const missing = (reason: string): Classified => ({
    reason,
    amount: null,
    packageId: null,
    assignmentId: null,
    durationDays: null,
  });
  if (sourceNeedsReview) return missing('AMBIGUOUS_CORRELATION');
  if (correction) return missing('AMBIGUOUS_CORRECTION');
  if (!/^\d+$/.test(bytesText)) return missing('PRICING_CONFIG_CONFLICT');
  const bytes = BigInt(bytesText);
  if (bytes === 0n) return missing('UNEXPECTED_UNLIMITED');
  const seconds = secondsText === null ? null : BigInt(secondsText);
  const duration =
    seconds !== null && seconds > 0n && seconds % 86400n === 0n
      ? Number(seconds / 86400n)
      : null;
  // Direct-admin exceptions precede group rules *for the same exact shape*.
  const eligible = (r: Rule) =>
    r.rate_toman_per_gib !== null ||
    (duration !== null &&
      duration <= 36500 &&
      r.package_bytes === bytesText &&
      r.duration_days === duration);
  const direct = rules.filter((r) => r.target_kind === 'ADMIN' && eligible(r));
  const chosen = direct.length
    ? direct
    : rules.filter((r) => r.target_kind === 'GROUP' && eligible(r));
  if (chosen.length > 1) return missing('PRICING_CONFIG_CONFLICT');
  const rule = chosen[0];
  if (!rule) {
    return missing(duration === null ? 'MISSING_DURATION' : 'PRICING_MISSING');
  }
  const amount =
    rule.rate_toman_per_gib !== null
      ? (bytes * BigInt(rule.rate_toman_per_gib) + GIB - 1n) / GIB
      : BigInt(rule.amount_toman ?? '0');
  if (amount <= 0n || amount > MAX_BIGINT)
    return missing('PRICING_CONFIG_CONFLICT');
  return {
    reason: null,
    amount: amount.toString(),
    packageId: rule.package_id,
    assignmentId: rule.id,
    durationDays: duration,
  };
}

/** Classify a single account's Update/Reset events at its admin/day close. */
export function classifyRenewals(events: CreateRow[], rules: Rule[]) {
  const result = new Map<string, Classified>();
  const hold = (event: CreateRow, reason: string) =>
    result.set(event.id, {
      reason,
      amount: null,
      packageId: null,
      assignmentId: null,
      durationDays: null,
    });
  const changes = events.filter(
    (e) => e.action === 'user_updated' || e.action === 'data_usage_reset',
  );
  for (const e of changes) hold(e, 'AMBIGUOUS_CORRELATION');
  if (changes.length === 1 && changes[0]!.action === 'data_usage_reset') {
    const e = changes[0]!;
    result.set(
      e.id,
      classifyCreate(
        e.data_limit_bytes,
        e.on_hold_expire_duration_seconds,
        rules,
        false,
        e.event_status !== 'READY_FOR_ACCOUNTING',
      ),
    );
  }
  if (changes.length !== 2) return result;
  const [first, second] = changes as [CreateRow, CreateRow];
  const delta =
    second.source_enqueued_at.getTime() - first.source_enqueued_at.getTime();
  if (
    delta < 0 ||
    delta > 300000 ||
    first.action === second.action ||
    changes.some((e) => e.event_status !== 'READY_FOR_ACCOUNTING') ||
    events.indexOf(second) !== events.indexOf(first) + 1
  )
    return result;
  const update = first.action === 'user_updated' ? first : second;
  const reset = first === update ? second : first;
  if (
    update.on_hold_expire_duration_seconds &&
    reset.on_hold_expire_duration_seconds &&
    update.on_hold_expire_duration_seconds !==
      reset.on_hold_expire_duration_seconds
  )
    return result;
  const duration =
    update.on_hold_expire_duration_seconds ??
    (update.data_limit_bytes === reset.data_limit_bytes
      ? reset.on_hold_expire_duration_seconds
      : null);
  const charge = classifyCreate(
    update.data_limit_bytes,
    duration,
    rules,
    false,
    false,
  );
  if (charge.reason) return result;
  result.set(update.id, charge);
  hold(reset, 'RENEWAL_EVIDENCE');
  return result;
}

/** Single-runner transactional close; historic membership is taken as of local midnight. */
export class NightlyShadow {
  readonly zone: string;
  constructor(
    private readonly db: DataSource,
    zone: string,
    private readonly runAfter: string = '02:10',
    private readonly liveSource: string = 'primary',
  ) {
    this.zone = validateTimeZone(zone);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(runAfter))
      throw new RangeError('INVALID_SHADOW_CLOSE_TIME');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(liveSource))
      throw new RangeError('INVALID_SHADOW_SOURCE');
  }

  private inNightWindow(now: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const clock = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
    // Running late backfills during the day would violate the Owner's nightly-only rule.
    const [hour, minute] = this.runAfter.split(':').map(Number);
    const minutes = hour! * 60 + minute!;
    const [currentHour, currentMinute] = clock.split(':').map(Number);
    const current = currentHour! * 60 + currentMinute!;
    return current >= minutes && current < Math.min(1440, minutes + 110);
  }

  /** A bounded catch-up batch; older days are replayed only in following night windows. */
  async run(now = new Date()): Promise<number> {
    if (!this.inNightWindow(now)) return 0;
    const [existingZone] = await this.db.query<{ time_zone: string }[]>(
      'SELECT time_zone FROM fair_shadow_days WHERE time_zone<>$1 LIMIT 1',
      [this.zone],
    );
    if (existingZone)
      throw new Error('SHADOW_TIME_ZONE_CHANGE_REQUIRES_REVIEW');
    let count = 0;
    for (; count < 25; count++) {
      const processed = await this.closeNext(now);
      if (!processed) break;
    }
    return count;
  }

  private async closeNext(now: Date): Promise<boolean> {
    return this.db.transaction('SERIALIZABLE', async (tx) => {
      // A transaction lock also serializes multiple application replicas.
      const [lock] = await tx.query<{ locked: boolean }[]>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('fair-shadow-nightly-create',0)) AS locked",
      );
      if (!lock?.locked) return false;
      const [candidate] = await tx.query<CreateRow[]>(
        `SELECT e.id::text,e.source_instance_id,e.billing_admin_id::text,
          e.external_user_id::text,e.username,e.source_enqueued_at,e.data_limit_bytes::text,
          e.on_hold_expire_duration_seconds::text,e.event_status
         FROM pasarguard_events e LEFT JOIN fair_shadow_items i ON i.event_id=e.id
         LEFT JOIN fair_shadow_late_events l ON l.event_id=e.id
         WHERE e.action IN ('user_created','user_updated','data_usage_reset') AND e.source_instance_id=$2
           AND i.event_id IS NULL AND l.event_id IS NULL
           AND e.source_enqueued_at < $1::timestamptz
         ORDER BY e.source_enqueued_at,e.id LIMIT 1`,
        [now.toISOString(), this.liveSource],
      );
      if (!candidate) return false;
      const day = localJalaliDate(candidate.source_enqueued_at, this.zone);
      const window = jalaliValidityWindow(this.zone, day, day);
      const start = window.fromUtc;
      const end = window.untilUtc!;
      // Never close a day until its *next* local midnight and receipt grace have passed.
      if (Date.parse(end) + 10 * 60_000 > now.getTime()) return false;
      const [closed] = await tx.query<{ id: string }[]>(
        `SELECT id::text FROM fair_shadow_days
         WHERE source_instance_id=$1 AND billing_admin_id=$2 AND local_day=$3`,
        [candidate.source_instance_id, candidate.billing_admin_id, day],
      );
      if (closed) {
        await tx.query(
          `INSERT INTO fair_shadow_late_events(event_id,day_id,source_instance_id,billing_admin_id,local_day)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [
            candidate.id,
            closed.id,
            candidate.source_instance_id,
            candidate.billing_admin_id,
            day,
          ],
        );
        return true;
      }
      const rows = await tx.query<CreateRow[]>(
        `SELECT id::text,action,source_instance_id,billing_admin_id::text,external_user_id::text,
          username,source_enqueued_at,data_limit_bytes::text,
          on_hold_expire_duration_seconds::text,event_status
         FROM pasarguard_events WHERE action IN ('user_created','user_updated','data_usage_reset') AND source_instance_id=$1
           AND billing_admin_id=$2 AND source_enqueued_at >= $3 AND source_enqueued_at < $4
           AND first_seen_at <= $5 ORDER BY source_enqueued_at,id`,
        [
          candidate.source_instance_id,
          candidate.billing_admin_id,
          start,
          end,
          now,
        ],
      );
      const [membership] = await tx.query<{ groupId: string | null }[]>(
        `SELECT new_group_id::text AS "groupId" FROM fair_admin_group_membership_audit
         WHERE source_instance_id=$1 AND billing_admin_id=$2 AND changed_at < $3
         ORDER BY changed_at DESC,id DESC LIMIT 1`,
        [candidate.source_instance_id, candidate.billing_admin_id, end],
      );
      // If audit history is absent but a membership is present, do not assume it
      // was active at this historical midnight; direct admin pricing can still match.
      const groupId = membership?.groupId ?? null;
      const rules = await this.rules(
        tx,
        candidate.source_instance_id,
        candidate.billing_admin_id,
        groupId,
        end,
      );
      const classified: Classified[] = [];
      const accounts = new Map<string, CreateRow[]>();
      for (const row of rows) {
        const account = accounts.get(row.external_user_id) ?? [];
        account.push(row);
        accounts.set(row.external_user_id, account);
      }
      const renewals = new Map<string, Classified>();
      for (const account of accounts.values()) {
        for (const [id, result] of classifyRenewals(account, rules))
          renewals.set(id, result);
      }
      for (const event of rows) {
        const renewal = renewals.get(event.id);
        if (renewal) {
          classified.push(renewal);
          continue;
        }
        const [correction] = await tx.query<{ exists: boolean }[]>(
          `SELECT EXISTS(SELECT 1 FROM pasarguard_events other
            WHERE other.source_instance_id=$1 AND other.username=$2
              AND other.id<>$3 AND other.source_enqueued_at >= $4 AND other.source_enqueued_at < $5
              AND other.action IN ('user_created','user_deleted')) AS exists`,
          [event.source_instance_id, event.username, event.id, start, end],
        );
        classified.push(
          classifyCreate(
            event.data_limit_bytes,
            event.on_hold_expire_duration_seconds,
            rules,
            !!correction?.exists,
            event.event_status !== 'READY_FOR_ACCOUNTING',
          ),
        );
      }
      let sum = classified.reduce((n, v) => n + BigInt(v.amount ?? '0'), 0n);
      if (sum > MAX_BIGINT && classified.length) {
        classified[0] = {
          reason: 'PRICING_CONFIG_CONFLICT',
          amount: null,
          packageId: null,
          assignmentId: null,
          durationDays: null,
        };
        sum = 0n;
      }
      const ambiguityCount = classified.filter(
        (v) => v.reason !== null && v.reason !== 'RENEWAL_EVIDENCE',
      ).length;
      const total = ambiguityCount === 0 ? sum.toString() : null;
      const [closure] = await tx.query<{ id: string }[]>(
        `INSERT INTO fair_shadow_days(source_instance_id,billing_admin_id,local_day,time_zone,
          window_start,window_end,source_watermark,group_id_at_close,status,total_toman,
          create_count,ambiguity_count)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text`,
        [
          candidate.source_instance_id,
          candidate.billing_admin_id,
          day,
          this.zone,
          start,
          end,
          now.toISOString(),
          groupId,
          total === null ? 'PENDING_REVIEW' : 'SHADOW_READY',
          total,
          rows.length,
          ambiguityCount,
        ],
      );
      for (let index = 0; index < rows.length; index++) {
        const event = rows[index]!;
        const result = classified[index]!;
        await tx.query(
          `INSERT INTO fair_shadow_items(event_id,day_id,source_instance_id,billing_admin_id,
            local_day,reason_code,amount_toman,matched_package_id,matched_assignment_id,
            data_limit_bytes,duration_days,source_enqueued_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            event.id,
            closure!.id,
            event.source_instance_id,
            event.billing_admin_id,
            day,
            result.reason,
            result.amount,
            result.packageId,
            result.assignmentId,
            event.data_limit_bytes,
            result.durationDays,
            event.source_enqueued_at,
          ],
        );
      }
      return true;
    });
  }

  private async rules(
    tx: EntityManager,
    source: string,
    admin: string,
    group: string | null,
    end: string,
  ): Promise<Rule[]> {
    return tx.query<Rule[]>(
      `SELECT a.id::text,a.target_kind,a.package_id::text,a.package_bytes::text,
        a.duration_days,p.amount_toman::text,a.rate_toman_per_gib::text
       FROM fair_tariff_assignments a
       LEFT JOIN fair_atomic_packages p ON p.id=a.package_id
       WHERE a.source_instance_id=$1 AND a.created_at < $3
         -- One tariff context at the exact day-close boundary. A rule that expired
         -- earlier in the day is not the rule in force at the midnight snapshot.
         -- The end is exclusive: a rule ending exactly at this midnight still
         -- applied to the preceding local day.
         AND a.effective_from < $3 AND (a.effective_until IS NULL OR a.effective_until >= $3)
         AND ((a.target_kind='ADMIN' AND a.billing_admin_id=$2)
           OR (a.target_kind='GROUP' AND a.group_id=$4::bigint))
       ORDER BY CASE WHEN a.target_kind='ADMIN' THEN 0 ELSE 1 END,a.id`,
      [source, admin, end, group],
    );
  }
}

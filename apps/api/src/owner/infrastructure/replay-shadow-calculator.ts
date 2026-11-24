import { localJalaliDate, validateTimeZone } from '@fair-platform/calendar';

const HALF_GIB = 536870912n;
const SECONDS_PER_DAY = 86400n;

export interface ReplaySourceEvent {
  id: string;
  action: string;
  billingAdminId: string;
  externalUserId: string;
  sourceTimestamp: string;
  dataLimitBytes: string;
  durationSeconds: string | null;
  eventStatus: string;
  userStatus: string;
  sourceUserCreatedAt: string | null;
  sourceUserExpiresAt: string | null;
}

export interface ReplayFixedPrice {
  packageId: string;
  bytes: string;
  days: number;
  amountToman: string;
}

export interface ReplayLedgerLine {
  operationKey: string;
  kind: 'CREATE' | 'UPDATE_INCREASE' | 'RENEWAL' | 'RESET' | 'DELETE_CREDIT';
  entryType: 'CHARGE' | 'CREDIT';
  billingAdminId: string;
  externalUserId: string;
  localDay: string;
  occurredAt: string;
  eventIds: string[];
  amountToman: string;
  packageId: string;
  referenceOperationKey: string | null;
}

export interface ReplayHold {
  operationKey: string;
  code: string;
  billingAdminId: string;
  externalUserId: string;
  localDay: string;
  occurredAt: string;
  eventIds: string[];
}

export interface ReplayDay {
  billingAdminId: string;
  localDay: string;
  status: 'SHADOW_READY' | 'PENDING_REVIEW';
  totalChargeToman: string | null;
  totalCreditToman: string | null;
  netToman: string | null;
  entryCount: number;
  holdCount: number;
}

export interface ReplayCalculation {
  days: ReplayDay[];
  /** Only entries on wholly unambiguous admin/days are financially posted. */
  entries: ReplayLedgerLine[];
  /** Provable candidates on held admin/days: review evidence, NEVER booked. */
  heldCandidates: ReplayLedgerLine[];
  holds: ReplayHold[];
  analyzedEvents: number;
  ignoredEvents: number;
  ignoredByAction: Array<{ action: string; reason: string; count: number }>;
  candidateEntriesHeld: number;
}

const dateOf = (event: ReplaySourceEvent, zone: string): string =>
  localJalaliDate(new Date(event.sourceTimestamp), zone);
const dayKey = (admin: string, day: string): string => `${admin}:${day}`;
const accountKey = (event: ReplaySourceEvent): string =>
  `${event.billingAdminId}:${event.externalUserId}`;
const eventKey = (kind: string, ids: string[]): string =>
  `${kind}:${ids.join(':')}`;

/** A strict, deterministic, Owner-attested historical SHADOW calculation.
 * It has no database, ledger, PasarGuard mutation or network dependency.
 * This is NOT a live source identity mapping or a financial cutover. */
export function calculateReplayShadow(
  events: readonly ReplaySourceEvent[],
  prices: readonly ReplayFixedPrice[],
  options: {
    timeZone: string;
    correlationWindowSeconds: number;
    deleteCreditEnabled: boolean;
  },
): ReplayCalculation {
  const zone = validateTimeZone(options.timeZone);
  if (
    !Number.isInteger(options.correlationWindowSeconds) ||
    options.correlationWindowSeconds < 1 ||
    options.correlationWindowSeconds > 600
  )
    throw new Error('INVALID_REPLAY_CORRELATION_WINDOW');
  const priceLookup = new Map<string, ReplayFixedPrice>();
  for (const price of prices) {
    if (
      !/^[1-9]\d*$/.test(price.bytes) ||
      !Number.isInteger(price.days) ||
      price.days < 1 ||
      !/^[1-9]\d*$/.test(price.amountToman)
    )
      throw new Error('INVALID_REPLAY_PRICE');
    const shape = `${price.bytes}:${price.days}`;
    if (priceLookup.has(shape)) throw new Error('DUPLICATE_REPLAY_PRICE');
    priceLookup.set(shape, price);
  }
  if (!priceLookup.size) throw new Error('EMPTY_REPLAY_PRICES');
  const accounts = new Map<string, ReplaySourceEvent[]>();
  const seenIds = new Set<string>();
  for (const e of events) {
    if (
      !/^[1-9]\d*$/.test(e.id) ||
      !/^(0|[1-9]\d*)$/.test(e.dataLimitBytes) ||
      !/^(0|[1-9]\d*)$/.test(e.billingAdminId) ||
      !/^(0|[1-9]\d*)$/.test(e.externalUserId) ||
      !Number.isFinite(Date.parse(e.sourceTimestamp)) ||
      seenIds.has(e.id)
    )
      throw new Error('INVALID_REPLAY_EVENT');
    seenIds.add(e.id);
    const key = accountKey(e);
    const existing = accounts.get(key) ?? [];
    existing.push(e);
    accounts.set(key, existing);
  }

  const candidates: ReplayLedgerLine[] = [];
  const holds: ReplayHold[] = [];
  const unresolvedByAccount = new Set<string>();
  let ignoredEvents = 0;
  const ignoredCounts = new Map<string, number>();
  const ignore = (event: ReplaySourceEvent, reason: string) => {
    ignoredEvents++;
    const key = `${event.action}\u0000${reason}`;
    ignoredCounts.set(key, (ignoredCounts.get(key) ?? 0) + 1);
  };
  const hold = (
    e: ReplaySourceEvent,
    kind: string,
    code: string,
    ids = [e.id],
  ) => {
    if (kind !== 'DELETE_CREDIT') unresolvedByAccount.add(accountKey(e));
    holds.push({
      operationKey: eventKey(kind, ids),
      code,
      billingAdminId: e.billingAdminId,
      externalUserId: e.externalUserId,
      localDay: dateOf(e, zone),
      occurredAt: e.sourceTimestamp,
      eventIds: ids,
    });
  };
  const createCharge = (
    e: ReplaySourceEvent,
    kind: ReplayLedgerLine['kind'],
    bytes: string,
    seconds: string | null,
    ids: string[],
    reference: string | null = null,
  ): ReplayLedgerLine | null => {
    if (e.eventStatus !== 'READY_FOR_ACCOUNTING') {
      hold(e, kind, 'SOURCE_NEEDS_REVIEW', ids);
      return null;
    }
    if (!/^[1-9]\d*$/.test(bytes)) {
      hold(e, kind, 'UNEXPECTED_UNLIMITED', ids);
      return null;
    }
    if (
      seconds === null ||
      !/^[1-9]\d*$/.test(seconds) ||
      BigInt(seconds) % SECONDS_PER_DAY !== 0n
    ) {
      hold(e, kind, 'MISSING_DURATION', ids);
      return null;
    }
    const days = BigInt(seconds) / SECONDS_PER_DAY;
    if (days > 36500n) {
      hold(e, kind, 'PRICING_MISSING', ids);
      return null;
    }
    const price = priceLookup.get(`${bytes}:${days}`);
    if (!price) {
      hold(e, kind, 'PRICING_MISSING', ids);
      return null;
    }
    const operationKey = eventKey(kind, ids);
    const line: ReplayLedgerLine = {
      operationKey,
      kind,
      entryType: 'CHARGE',
      billingAdminId: e.billingAdminId,
      externalUserId: e.externalUserId,
      localDay: dateOf(e, zone),
      occurredAt: e.sourceTimestamp,
      eventIds: ids,
      amountToman: price.amountToman,
      packageId: price.packageId,
      referenceOperationKey: reference,
    };
    candidates.push(line);
    unresolvedByAccount.delete(accountKey(e));
    return line;
  };

  for (const timeline of accounts.values()) {
    timeline.sort(
      (a, b) =>
        a.sourceTimestamp.localeCompare(b.sourceTimestamp) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    );
    const accountActionsByDay = new Map<string, Set<string>>();
    for (const item of timeline) {
      if (item.action !== 'user_updated' && item.action !== 'data_usage_reset')
        continue;
      const day = dateOf(item, zone);
      const actions = accountActionsByDay.get(day) ?? new Set<string>();
      actions.add(item.action);
      accountActionsByDay.set(day, actions);
    }
    let lastPurchase: ReplayLedgerLine | null = null;
    let purchaseCredited = false;
    for (let i = 0; i < timeline.length;) {
      const e = timeline[i]!;
      const previous = i > 0 ? timeline[i - 1]! : null;
      if (e.action === 'user_created') {
        let duration = e.durationSeconds;
        // Exact Owner-attested active trial exception; do not generalize
        // expiry differences to any other package duration.
        if (
          duration === null &&
          e.userStatus === 'active' &&
          BigInt(e.dataLimitBytes) === HALF_GIB &&
          e.sourceUserCreatedAt &&
          e.sourceUserExpiresAt
        ) {
          const created = Date.parse(e.sourceUserCreatedAt);
          const expiry = Date.parse(e.sourceUserExpiresAt);
          const enqueue = Date.parse(e.sourceTimestamp);
          if (
            Number.isFinite(created) &&
            Number.isFinite(expiry) &&
            enqueue - created >= 0 &&
            enqueue - created <= 1000 &&
            Math.abs(expiry - created - 2 * 86400000) <= 1000
          )
            duration = '172800';
        }
        const line = createCharge(e, 'CREATE', e.dataLimitBytes, duration, [
          e.id,
        ]);
        if (line) {
          lastPurchase = line;
          purchaseCredited = false;
        }
        i++;
        continue;
      }
      if (e.action === 'user_deleted') {
        if (options.deleteCreditEnabled) {
          if (e.eventStatus !== 'READY_FOR_ACCOUNTING')
            hold(e, 'DELETE_CREDIT', 'SOURCE_NEEDS_REVIEW');
          else if (unresolvedByAccount.has(accountKey(e)))
            hold(e, 'DELETE_CREDIT', 'CREDIT_SOURCE_NOT_PROVEN');
          else if (lastPurchase && !purchaseCredited) {
            candidates.push({
              ...lastPurchase,
              operationKey: eventKey('DELETE_CREDIT', [e.id]),
              kind: 'DELETE_CREDIT',
              entryType: 'CREDIT',
              localDay: dateOf(e, zone),
              occurredAt: e.sourceTimestamp,
              eventIds: [e.id],
              referenceOperationKey: lastPurchase.operationKey,
            });
            purchaseCredited = true;
          } else if (!lastPurchase)
            hold(e, 'DELETE_CREDIT', 'CREDIT_SOURCE_NOT_PROVEN');
          else ignore(e, 'ALREADY_CREDITED');
        } else ignore(e, 'DELETE_CREDIT_DISABLED');
        i++;
        continue;
      }
      const isUpdateReset = (action: string) =>
        action === 'user_updated' || action === 'data_usage_reset';
      if (isUpdateReset(e.action)) {
        // Partition complete source-time alternating chains. No HTTP arrival
        // time or arbitrary nearest neighbour pairing is used.
        const chain = [e];
        while (i + chain.length < timeline.length) {
          const next = timeline[i + chain.length]!;
          const tail = chain[chain.length - 1]!;
          if (
            !isUpdateReset(next.action) ||
            dateOf(next, zone) !== dateOf(tail, zone) ||
            next.sourceTimestamp < tail.sourceTimestamp ||
            Date.parse(next.sourceTimestamp) -
              Date.parse(tail.sourceTimestamp) >
              options.correlationWindowSeconds * 1000
          )
            break;
          chain.push(next);
        }
        if (chain.length > 1) {
          const alternating = chain.every(
            (item, index) =>
              index === 0 || item.action !== chain[index - 1]!.action,
          );
          if (!alternating || chain.length % 2 !== 0) {
            for (const item of chain)
              hold(item, 'CORRELATION', 'AMBIGUOUS_CORRELATION');
          } else {
            for (let offset = 0; offset < chain.length; offset += 2) {
              const left = chain[offset]!;
              const right = chain[offset + 1]!;
              const reset = left.action === 'data_usage_reset' ? left : right;
              const update = left.action === 'user_updated' ? left : right;
              if (
                reset.eventStatus !== 'READY_FOR_ACCOUNTING' ||
                update.eventStatus !== 'READY_FOR_ACCOUNTING'
              ) {
                hold(right, 'RENEWAL', 'SOURCE_NEEDS_REVIEW', [
                  left.id,
                  right.id,
                ]);
                continue;
              }
              if (
                reset.durationSeconds &&
                update.durationSeconds &&
                reset.durationSeconds !== update.durationSeconds &&
                !(
                  timeline[i + offset - 1]?.dataLimitBytes ===
                    reset.dataLimitBytes &&
                  timeline[i + offset - 1]?.durationSeconds ===
                    reset.durationSeconds &&
                  timeline[i + offset - 1]?.eventStatus ===
                    'READY_FOR_ACCOUNTING'
                )
              ) {
                hold(right, 'RENEWAL', 'DURATION_CONFLICT', [
                  left.id,
                  right.id,
                ]);
                continue;
              }
              // Update is the intended new package state in BOTH delivery orders.
              // Reset may still contain the previous expiry/duration, even if it
              // arrived later. Never price a renewal using that old Reset shape.
              const finalDuration =
                update.durationSeconds ??
                (update.dataLimitBytes === reset.dataLimitBytes
                  ? reset.durationSeconds
                  : null);
              const line = createCharge(
                update,
                'RENEWAL',
                update.dataLimitBytes,
                finalDuration,
                [left.id, right.id],
              );
              if (line) {
                lastPurchase = line;
                purchaseCredited = false;
              }
            }
          }
          i += chain.length;
          continue;
        }
        // Do not bill an isolated Update/Reset as independent when another
        // opposite action exists later on the same day but outside the
        // supported correlation window. End-of-day review is safer than a
        // duplicate charge or a guessed long-latency pairing.
        if (accountActionsByDay.get(dateOf(e, zone))?.size === 2) {
          hold(e, 'CORRELATION', 'CORRELATION_OUTSIDE_WINDOW');
          i++;
          continue;
        }
        if (e.action === 'data_usage_reset') {
          // A genuinely unpaired reset renews the whole verified package.
          const line = createCharge(
            e,
            'RESET',
            e.dataLimitBytes,
            e.durationSeconds,
            [e.id],
          );
          if (line) {
            lastPurchase = line;
            purchaseCredited = false;
          }
        } else if (
          !previous ||
          previous.eventStatus !== 'READY_FOR_ACCOUNTING'
        ) {
          hold(e, 'UPDATE_INCREASE', 'PREVIOUS_STATE_MISSING');
        } else if (e.eventStatus !== 'READY_FOR_ACCOUNTING') {
          hold(e, 'UPDATE_INCREASE', 'SOURCE_NEEDS_REVIEW');
        } else {
          const delta =
            BigInt(e.dataLimitBytes) - BigInt(previous.dataLimitBytes);
          if (delta > 0n) {
            const line = createCharge(
              e,
              'UPDATE_INCREASE',
              delta.toString(),
              e.durationSeconds,
              [e.id],
            );
            if (line) {
              lastPurchase = line;
              purchaseCredited = false;
            }
          } else
            ignore(e, delta < 0n ? 'NONBILLABLE_DECREASE' : 'UNCHANGED_LIMIT');
        }
        i++;
        continue;
      }
      if (e.action === 'data_reset_by_next')
        hold(e, 'NEXT_PLAN', 'NEXT_PLAN_NEEDS_VERIFICATION');
      else ignore(e, 'NONFINANCIAL_ACTION');
      i++;
    }
  }

  const holdsByDay = new Map<string, ReplayHold[]>();
  const candidatesByDay = new Map<string, ReplayLedgerLine[]>();
  for (const h of holds) {
    const key = dayKey(h.billingAdminId, h.localDay);
    holdsByDay.set(key, [...(holdsByDay.get(key) ?? []), h]);
  }
  for (const line of candidates) {
    const key = dayKey(line.billingAdminId, line.localDay);
    candidatesByDay.set(key, [...(candidatesByDay.get(key) ?? []), line]);
  }
  // A credit cannot be posted against a purchase on a held day. Iterate
  // until that constraint has propagated across all linked days.
  let changed = true;
  while (changed) {
    changed = false;
    const indexed = new Map(candidates.map((c) => [c.operationKey, c]));
    for (const credit of candidates.filter((c) => c.entryType === 'CREDIT')) {
      const reference = indexed.get(credit.referenceOperationKey ?? '');
      const sourceHeld =
        !reference ||
        holdsByDay.has(dayKey(reference.billingAdminId, reference.localDay));
      const targetKey = dayKey(credit.billingAdminId, credit.localDay);
      if (
        sourceHeld &&
        !holdsByDay
          .get(targetKey)
          ?.some((h) => h.operationKey === credit.operationKey)
      ) {
        const related: ReplayHold = {
          operationKey: credit.operationKey,
          code: 'CREDIT_SOURCE_NOT_POSTED',
          billingAdminId: credit.billingAdminId,
          externalUserId: credit.externalUserId,
          localDay: credit.localDay,
          occurredAt: credit.occurredAt,
          eventIds: credit.eventIds,
        };
        holds.push(related);
        holdsByDay.set(targetKey, [
          ...(holdsByDay.get(targetKey) ?? []),
          related,
        ]);
        changed = true;
      }
    }
  }

  const entries: ReplayLedgerLine[] = [];
  const heldCandidates: ReplayLedgerLine[] = [];
  const days: ReplayDay[] = [];
  const keys = new Set([...candidatesByDay.keys(), ...holdsByDay.keys()]);
  for (const key of [...keys].sort()) {
    const lines = candidatesByDay.get(key) ?? [];
    const blocked = holdsByDay.get(key) ?? [];
    const [admin, localDay] = key.split(':') as [string, string];
    if (blocked.length) {
      heldCandidates.push(...lines);
      days.push({
        billingAdminId: admin,
        localDay,
        status: 'PENDING_REVIEW',
        totalChargeToman: null,
        totalCreditToman: null,
        netToman: null,
        entryCount: 0,
        holdCount: blocked.length,
      });
    } else {
      const charges = lines
        .filter((l) => l.entryType === 'CHARGE')
        .reduce((total, l) => total + BigInt(l.amountToman), 0n);
      const credits = lines
        .filter((l) => l.entryType === 'CREDIT')
        .reduce((total, l) => total + BigInt(l.amountToman), 0n);
      days.push({
        billingAdminId: admin,
        localDay,
        status: 'SHADOW_READY',
        totalChargeToman: charges.toString(),
        totalCreditToman: credits.toString(),
        netToman: (charges - credits).toString(),
        entryCount: lines.length,
        holdCount: 0,
      });
      entries.push(...lines);
    }
  }
  return {
    days,
    entries,
    heldCandidates,
    holds,
    analyzedEvents: events.length,
    ignoredEvents,
    ignoredByAction: [...ignoredCounts]
      .map(([key, count]) => {
        const [action, reason] = key.split('\u0000') as [string, string];
        return { action, reason, count };
      })
      .sort(
        (a, b) =>
          a.action.localeCompare(b.action) || a.reason.localeCompare(b.reason),
      ),
    candidateEntriesHeld: heldCandidates.length,
  };
}

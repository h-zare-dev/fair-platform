import type { evaluateReplayStaticCatalog } from './replay-preview.js';

const SECONDS_PER_DAY = 86400n;
type CreatePreview = ReturnType<typeof evaluateReplayStaticCatalog>;

/** Aggregated in SQL: no source user, admin or event identifiers leave PostgreSQL. */
export interface PreviewOperationAggregate {
  kind: 'UPDATE_ONLY' | 'RESET_ONLY' | 'RENEWAL';
  dataLimitBytes: string;
  previousBytes: string | null;
  onHoldDurationSeconds: string | null;
  eventStatus: string;
  counterpartStatus: string | null;
  previousEventStatus: string | null;
  orderedPrevious: boolean;
  ambiguousCounterpart: boolean;
  eventCount: number;
}

/**
 * FP-006/007 Owner-attested, non-posting replay. A unique Reset+Update is
 * one renewal at the final package. Independent increases price only the
 * positive exact-package delta; decreases do not refund. Unproven state or
 * correlation always fails closed. No historical identity is asserted.
 */
export function evaluateReplayUpdateResetPreview(
  create: CreatePreview,
  operations: readonly PreviewOperationAggregate[],
  correlationWindowSeconds: number,
) {
  if (
    !Number.isInteger(correlationWindowSeconds) ||
    correlationWindowSeconds < 1 ||
    correlationWindowSeconds > 600
  )
    throw new RangeError('INVALID_CORRELATION_WINDOW');
  const count = (kind: PreviewOperationAggregate['kind']) =>
    operations
      .filter((row) => row.kind === kind)
      .reduce((n, row) => n + row.eventCount, 0);
  const pairedRenewalCount = count('RENEWAL');
  const updateOnlyEventCount = count('UPDATE_ONLY');
  const resetOnlyEventCount = count('RESET_ONLY');
  const updateEventCount =
    create.actionCounts.find((row) => row.action === 'user_updated')?.count ??
    0;
  const resetEventCount =
    create.actionCounts.find((row) => row.action === 'data_usage_reset')
      ?.count ?? 0;
  const groupedValid =
    operations.length <= 70000 &&
    operations.every(
      (row) =>
        ['UPDATE_ONLY', 'RESET_ONLY', 'RENEWAL'].includes(row.kind) &&
        Number.isSafeInteger(row.eventCount) &&
        row.eventCount > 0 &&
        typeof row.orderedPrevious === 'boolean' &&
        typeof row.ambiguousCounterpart === 'boolean',
    ) &&
    pairedRenewalCount + updateOnlyEventCount === updateEventCount &&
    pairedRenewalCount + resetOnlyEventCount === resetEventCount;
  const ready =
    create.configurationReady && create.ingestionReady && groupedValid;
  const packageBreakdown = create.ownerAttestedWhatIf.packageBreakdown.map(
    (pkg) => ({
      packageBytes: pkg.packageBytes,
      durationDays: pkg.durationDays,
      amountToman: pkg.amountToman,
      pricedOperationCount: 0,
      subtotalToman: '0',
    }),
  );
  const shapes = new Map(
    packageBreakdown.map((pkg) => [
      `${pkg.packageBytes}:${pkg.durationDays}`,
      pkg,
    ]),
  );
  const reasons = new Map<string, number>();
  const hold = (reason: string, n: number) =>
    reasons.set(reason, (reasons.get(reason) ?? 0) + n);
  let pricedUpdateOnlyCount = 0;
  let pricedRenewalCount = 0;
  let pricedStandaloneResetCount = 0;
  let decreaseUpdateCount = 0;
  let unchangedUpdateCount = 0;
  let subtotal = 0n;
  let ambiguousUpdateCount = 0;
  let ambiguousResetCount = 0;
  let priorSnapshotMissingCount = 0;

  for (const row of operations) {
    const n = row.eventCount;
    if (row.ambiguousCounterpart && row.kind === 'UPDATE_ONLY')
      ambiguousUpdateCount += n;
    if (row.ambiguousCounterpart && row.kind === 'RESET_ONLY')
      ambiguousResetCount += n;
    if (row.kind === 'UPDATE_ONLY' && row.previousBytes === null)
      priorSnapshotMissingCount += n;
    if (!ready) {
      hold(
        !create.ingestionReady || !groupedValid
          ? 'REPLAY_INGESTION_INCOMPLETE'
          : 'CATALOG_COVERAGE_INCOMPLETE',
        n,
      );
      continue;
    }
    if (row.ambiguousCounterpart) {
      hold('AMBIGUOUS_CORRELATION', n);
      continue;
    }
    if (
      row.eventStatus !== 'READY_FOR_ACCOUNTING' ||
      (row.kind === 'RENEWAL' &&
        row.counterpartStatus !== 'READY_FOR_ACCOUNTING')
    ) {
      hold('SOURCE_NEEDS_REVIEW', n);
      continue;
    }
    if (row.kind === 'RENEWAL' && !row.orderedPrevious) {
      hold('AMBIGUOUS_STATE_ORDER', n);
      continue;
    }
    let billableBytes = row.dataLimitBytes;
    if (row.kind === 'UPDATE_ONLY') {
      if (
        row.previousBytes === null ||
        row.previousEventStatus !== 'READY_FOR_ACCOUNTING'
      ) {
        hold('PREVIOUS_STATE_MISSING', n);
        continue;
      }
      if (!row.orderedPrevious) {
        hold('AMBIGUOUS_STATE_ORDER', n);
        continue;
      }
      if (
        !/^\d+$/.test(row.previousBytes) ||
        !/^\d+$/.test(row.dataLimitBytes)
      ) {
        hold('SOURCE_PROJECTION_INVALID', n);
        continue;
      }
      const previous = BigInt(row.previousBytes);
      const current = BigInt(row.dataLimitBytes);
      if (previous === 0n || current === 0n) {
        hold('UNEXPECTED_UNLIMITED', n);
        continue;
      }
      const delta = current - previous;
      if (delta < 0n) {
        decreaseUpdateCount += n;
        continue;
      }
      if (delta === 0n) {
        unchangedUpdateCount += n;
        continue;
      }
      billableBytes = delta.toString();
    }
    if (!/^\d+$/.test(billableBytes) || BigInt(billableBytes) === 0n) {
      hold('UNEXPECTED_UNLIMITED', n);
      continue;
    }
    if (
      row.onHoldDurationSeconds === null ||
      !/^\d+$/.test(row.onHoldDurationSeconds)
    ) {
      hold('MISSING_DURATION', n);
      continue;
    }
    const seconds = BigInt(row.onHoldDurationSeconds);
    if (seconds === 0n || seconds % SECONDS_PER_DAY !== 0n) {
      hold('MISSING_DURATION', n);
      continue;
    }
    const days = seconds / SECONDS_PER_DAY;
    if (days > 36500n) {
      hold('PRICING_MISSING', n);
      continue;
    }
    const pkg = shapes.get(`${billableBytes}:${days}`);
    if (!pkg) {
      hold('PRICING_MISSING', n);
      continue;
    }
    const amount = BigInt(pkg.amountToman) * BigInt(n);
    pkg.pricedOperationCount += n;
    pkg.subtotalToman = (BigInt(pkg.subtotalToman) + amount).toString();
    subtotal += amount;
    if (row.kind === 'RENEWAL') pricedRenewalCount += n;
    else if (row.kind === 'RESET_ONLY') pricedStandaloneResetCount += n;
    else pricedUpdateOnlyCount += n;
  }
  return {
    mode: 'HISTORICAL_UPDATE_RESET_PREVIEW' as const,
    source: 'replay-30d' as const,
    postingScope: 'NONE' as const,
    completeAccounting: false as const,
    assumption:
      'OWNER_ATTESTED_UNCHANGED_CATALOG_AND_SOURCE_SNAPSHOTS' as const,
    correlationWindowSeconds,
    configurationReady: create.configurationReady,
    ingestionReady: create.ingestionReady && groupedValid,
    updateEventCount,
    resetEventCount,
    pairedRenewalCount,
    updateOnlyEventCount,
    resetOnlyEventCount,
    ambiguousUpdateCount,
    ambiguousResetCount,
    priorSnapshotMissingCount,
    pricedUpdateOnlyCount,
    pricedRenewalCount,
    pricedStandaloneResetCount,
    decreaseUpdateCount,
    unchangedUpdateCount,
    heldOperationCount: [...reasons.values()].reduce((a, b) => a + b, 0),
    updateResetSubtotalToman: ready ? subtotal.toString() : null,
    packageBreakdown: ready ? packageBreakdown : [],
    heldReasons: [...reasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
  };
}

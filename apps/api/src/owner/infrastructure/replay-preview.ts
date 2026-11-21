import { localJalaliDate, validateTimeZone } from '@fair-platform/calendar';
import { classifyCreate } from './nightly-shadow.js';

export interface PreviewPackage {
  id: string;
  packageBytes: string;
  durationDays: number;
  amountToman: string;
}
export interface PreviewMembership {
  billingAdminId: string;
  groupId: string;
}
export interface PreviewAssignment {
  id: string;
  targetKind: 'GROUP' | 'ADMIN';
  groupId: string | null;
  billingAdminId: string | null;
  packageId: string | null;
  rateTomanPerGiB: string | null;
}
export interface PreviewEvent {
  action: string;
  billingAdminId: string;
  username: string;
  sourceTimestamp: Date;
  dataLimitBytes: string;
  onHoldDurationSeconds: string | null;
  eventStatus: string;
}
export interface PreviewIngestion {
  batchCount: string;
  childCount: string;
  unfinishedBatches: string;
}

/**
 * Read-only hypothetical historical quote. This deliberately does not reconstruct
 * past membership or authorize posting. The Owner attests that the same 25
 * package prices applied throughout the replay window; missing evidence is held.
 */
export function evaluateReplayStaticCatalog(
  packages: readonly PreviewPackage[],
  memberships: readonly PreviewMembership[],
  assignments: readonly PreviewAssignment[],
  events: readonly PreviewEvent[],
  zone: string,
  ingestion: PreviewIngestion,
) {
  const timeZone = validateTimeZone(zone);
  const groupIds = new Set(memberships.map((item) => item.groupId));
  const onlyGroup = groupIds.size === 1 ? [...groupIds][0]! : null;
  const packageMap = new Map(packages.map((item) => [item.id, item]));
  const packageShapes = new Set(
    packages.map((item) => `${item.packageBytes}:${item.durationDays}`),
  );
  const packagesValid = packages.every(
    (item) =>
      /^\d+$/.test(item.packageBytes) &&
      BigInt(item.packageBytes) > 0n &&
      Number.isInteger(item.durationDays) &&
      item.durationDays > 0 &&
      item.durationDays <= 36500 &&
      /^\d+$/.test(item.amountToman) &&
      BigInt(item.amountToman) > 0n &&
      BigInt(item.amountToman) <= 9223372036854775807n,
  );
  const groupAssignments = assignments.filter(
    (item) =>
      item.targetKind === 'GROUP' &&
      item.groupId === onlyGroup &&
      item.packageId !== null &&
      item.rateTomanPerGiB === null &&
      packageMap.has(item.packageId),
  );
  const assignedPackageIds = new Set(groupAssignments.map((v) => v.packageId));
  const configurationReady =
    packages.length === 25 &&
    packageMap.size === 25 &&
    packageShapes.size === 25 &&
    packagesValid &&
    memberships.length === 153 &&
    new Set(memberships.map((v) => v.billingAdminId)).size === 153 &&
    onlyGroup !== null &&
    assignments.length === 25 &&
    groupAssignments.length === 25 &&
    assignedPackageIds.size === 25;
  const ingestionReady =
    ingestion.batchCount === '15914' &&
    ingestion.childCount === '64135' &&
    ingestion.unfinishedBatches === '0';
  const previewReady = configurationReady && ingestionReady;

  const memberIds = new Set(memberships.map((v) => v.billingAdminId));
  const rules = groupAssignments.map((assignment) => {
    const pkg = packageMap.get(assignment.packageId!)!;
    return {
      id: assignment.id,
      target_kind: 'GROUP' as const,
      package_id: pkg.id,
      package_bytes: pkg.packageBytes,
      duration_days: pkg.durationDays,
      amount_toman: pkg.amountToman,
      rate_toman_per_gib: null,
    };
  });

  const actions = new Map<string, number>();
  const corrections = new Map<string, number>();
  for (const event of events) {
    actions.set(event.action, (actions.get(event.action) ?? 0) + 1);
    if (event.action === 'user_created' || event.action === 'user_deleted') {
      const day = localJalaliDate(event.sourceTimestamp, timeZone);
      const key = `${event.username}\0${day}`;
      corrections.set(key, (corrections.get(key) ?? 0) + 1);
    }
  }

  const reasons = new Map<string, number>();
  const held = (reason: string) =>
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const packageTotals = new Map<string, { count: number; sum: bigint }>(
    packages.map((pkg) => [pkg.id, { count: 0, sum: 0n }]),
  );
  let pricedCreates = 0;
  let subtotal = 0n;
  for (const event of events) {
    if (event.action !== 'user_created') continue;
    if (!previewReady) {
      held(
        !ingestionReady
          ? 'REPLAY_INGESTION_INCOMPLETE'
          : 'CATALOG_COVERAGE_INCOMPLETE',
      );
      continue;
    }
    if (!memberIds.has(event.billingAdminId)) {
      held('ADMIN_MEMBERSHIP_MISSING');
      continue;
    }
    try {
      const day = localJalaliDate(event.sourceTimestamp, timeZone);
      const correction =
        (corrections.get(`${event.username}\0${day}`) ?? 0) > 1;
      const price = classifyCreate(
        event.dataLimitBytes,
        event.onHoldDurationSeconds,
        rules,
        correction,
        event.eventStatus !== 'READY_FOR_ACCOUNTING',
      );
      if (price.reason !== null || price.amount === null) {
        held(price.reason ?? 'PRICING_CONFIG_CONFLICT');
      } else {
        subtotal += BigInt(price.amount);
        pricedCreates++;
        const total = packageTotals.get(price.packageId!);
        if (total) {
          total.count++;
          total.sum += BigInt(price.amount);
        }
      }
    } catch {
      held('SOURCE_PROJECTION_INVALID');
    }
  }
  const createEvents = actions.get('user_created') ?? 0;
  return {
    mode: 'HISTORICAL_STATIC_PACKAGE_PREVIEW' as const,
    source: 'replay-30d' as const,
    postingScope: 'NONE' as const,
    completeAccounting: false,
    priceHistoryAssumption: 'OWNER_ATTESTED_UNCHANGED_SIX_MONTHS' as const,
    expectedPackages: 25,
    expectedAdmins: 153,
    expectedBatches: 15914,
    expectedInputChildren: 64135,
    ingestedBatchCount: ingestion.batchCount,
    ingestedChildCount: ingestion.childCount,
    unfinishedBatchCount: ingestion.unfinishedBatches,
    ingestionReady,
    packageCount: packages.length,
    groupCount: groupIds.size,
    memberCount: memberships.length,
    assignedPackageCount: assignedPackageIds.size,
    configurationReady,
    normalizedEventCount: events.length,
    createEventCount: createEvents,
    pricedCreateCount: pricedCreates,
    heldCreateCount: createEvents - pricedCreates,
    // Null means the catalog/membership preflight failed. Even when present,
    // this is a PARTIAL Create-only quote, NEVER a daily or monthly balance.
    createOnlySubtotalToman: previewReady ? subtotal.toString() : null,
    // Package-level aggregates support cross-checking the legacy price table
    // without ever returning an account, user or event identity.
    packageBreakdown: previewReady
      ? packages.map((pkg) => ({
          packageBytes: pkg.packageBytes,
          durationDays: pkg.durationDays,
          amountToman: pkg.amountToman,
          pricedCreateCount: packageTotals.get(pkg.id)!.count,
          subtotalToman: packageTotals.get(pkg.id)!.sum.toString(),
        }))
      : [],
    unclassifiedEventCount: events.length - createEvents,
    actionCounts: [...actions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([action, count]) => ({ action, count })),
    heldReasons: [...reasons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
  };
}

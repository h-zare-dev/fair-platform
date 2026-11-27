import { validateTimeZone } from '@fair-platform/calendar';
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
/** One count per shape/status/correction; no usernames or individual events leave SQL. */
export interface PreviewCreateAggregate {
  billingAdminId: string;
  dataLimitBytes: string;
  onHoldDurationSeconds: string | null;
  eventStatus: string;
  isCorrection: boolean;
  /** SQL-only evidence for the Owner-approved, non-posting 0.5 GiB / 2-day assumption. */
  activeTwoDayDateCandidate: boolean;
  eventCount: number;
}
export interface PreviewActionAggregate {
  action: string;
  eventCount: number;
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
  createGroups: readonly PreviewCreateAggregate[],
  actionGroups: readonly PreviewActionAggregate[],
  zone: string,
  ingestion: PreviewIngestion,
) {
  validateTimeZone(zone);
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
  const actions = new Map<string, number>();
  const actionCountsValid = actionGroups.every(
    (row) => Number.isSafeInteger(row.eventCount) && row.eventCount > 0,
  );
  for (const row of actionGroups)
    actions.set(row.action, (actions.get(row.action) ?? 0) + row.eventCount);
  const normalizedEvents = [...actions.values()].reduce((a, b) => a + b, 0);
  const createEvents = actions.get('user_created') ?? 0;
  const groupedCreateEvents = createGroups.reduce(
    (a, row) => a + row.eventCount,
    0,
  );
  const aggregatesValid =
    actionCountsValid &&
    normalizedEvents <= 70000 &&
    createGroups.length <= 70000 &&
    createGroups.every(
      (row) => Number.isSafeInteger(row.eventCount) && row.eventCount > 0,
    ) &&
    createEvents === groupedCreateEvents;
  const ingestionReady =
    ingestion.batchCount === '15914' &&
    ingestion.childCount === '64135' &&
    ingestion.unfinishedBatches === '0' &&
    aggregatesValid;
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

  // Two deliberately separate calculations: the original identity-verified
  // quote still fails closed. The Owner's *hypothetical* all-admin scenario
  // may evaluate the same price shapes without asserting that an archive ID
  // belongs to today's PasarGuard directory. Never combine the totals.
  const quote = (
    requireIdentityMatch: boolean,
    allowOwnerAttestedActiveTwoDay: boolean,
  ) => {
    const reasons = new Map<string, number>();
    const held = (reason: string, count: number) =>
      reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    const packageTotals = new Map<string, { count: number; sum: bigint }>(
      packages.map((pkg) => [pkg.id, { count: 0, sum: 0n }]),
    );
    let pricedCreates = 0;
    let subtotal = 0n;
    let inferredActiveTwoDayCreates = 0;
    for (const event of createGroups) {
      if (!previewReady) {
        held(
          !ingestionReady
            ? 'REPLAY_INGESTION_INCOMPLETE'
            : 'CATALOG_COVERAGE_INCOMPLETE',
          event.eventCount,
        );
        continue;
      }
      if (requireIdentityMatch && !memberIds.has(event.billingAdminId)) {
        held('ADMIN_MEMBERSHIP_MISSING', event.eventCount);
        continue;
      }
      try {
        const inferActiveTwoDay =
          allowOwnerAttestedActiveTwoDay &&
          event.activeTwoDayDateCandidate === true &&
          event.dataLimitBytes === '536870912' &&
          event.onHoldDurationSeconds === null;
        const price = classifyCreate(
          event.dataLimitBytes,
          inferActiveTwoDay ? '172800' : event.onHoldDurationSeconds,
          rules,
          event.isCorrection,
          event.eventStatus !== 'READY_FOR_ACCOUNTING',
        );
        if (price.reason !== null || price.amount === null) {
          held(price.reason ?? 'PRICING_CONFIG_CONFLICT', event.eventCount);
        } else {
          const amount = BigInt(price.amount) * BigInt(event.eventCount);
          subtotal += amount;
          pricedCreates += event.eventCount;
          if (inferActiveTwoDay)
            inferredActiveTwoDayCreates += event.eventCount;
          const total = packageTotals.get(price.packageId!);
          if (total) {
            total.count += event.eventCount;
            total.sum += amount;
          }
        }
      } catch {
        held('SOURCE_PROJECTION_INVALID', event.eventCount);
      }
    }
    return {
      pricedCreates,
      subtotal,
      inferredActiveTwoDayCreates,
      packageBreakdown: previewReady
        ? packages.map((pkg) => ({
            packageBytes: pkg.packageBytes,
            durationDays: pkg.durationDays,
            amountToman: pkg.amountToman,
            pricedCreateCount: packageTotals.get(pkg.id)!.count,
            subtotalToman: packageTotals.get(pkg.id)!.sum.toString(),
          }))
        : [],
      heldReasons: [...reasons.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([code, count]) => ({ code, count })),
    };
  };
  const strict = quote(true, false);
  const hypothetical = quote(false, true);
  const identityMatchedCreateCount = createGroups.reduce(
    (count, event) =>
      count + (memberIds.has(event.billingAdminId) ? event.eventCount : 0),
    0,
  );
  const identityUnmatchedCreateCount = createGroups.reduce(
    (count, event) =>
      count + (!memberIds.has(event.billingAdminId) ? event.eventCount : 0),
    0,
  );
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
    normalizedEventCount: normalizedEvents,
    createEventCount: createEvents,
    pricedCreateCount: strict.pricedCreates,
    heldCreateCount: createEvents - strict.pricedCreates,
    // Null means the catalog/membership preflight failed. Even when present,
    // this is a PARTIAL Create-only quote, NEVER a daily or monthly balance.
    createOnlySubtotalToman: previewReady ? strict.subtotal.toString() : null,
    // Package-level aggregates support cross-checking the legacy price table
    // without ever returning an account, user or event identity.
    packageBreakdown: strict.packageBreakdown,
    unclassifiedEventCount: normalizedEvents - createEvents,
    actionCounts: [...actions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([action, count]) => ({ action, count })),
    heldReasons: strict.heldReasons,
    ownerAttestedWhatIf: {
      assumption: 'ALL_REPLAY_ADMINS_USE_SINGLE_CONFIGURED_GROUP' as const,
      // This checks numeric ID inclusion, not historical identity provenance.
      allCreateIdsMatchMemberships:
        previewReady && createEvents > 0 && identityUnmatchedCreateCount === 0,
      identityMatchedCreateCount,
      identityUnmatchedCreateCount,
      pricedCreateCount: hypothetical.pricedCreates,
      heldCreateCount: createEvents - hypothetical.pricedCreates,
      activeTwoDayInferredPricedCreateCount:
        hypothetical.inferredActiveTwoDayCreates,
      createOnlySubtotalToman: previewReady
        ? hypothetical.subtotal.toString()
        : null,
      packageBreakdown: hypothetical.packageBreakdown,
      heldReasons: hypothetical.heldReasons,
    },
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import { evaluateReplayStaticCatalog } from '../../apps/api/dist/owner/infrastructure/replay-preview.js';
import {
  evaluateReplayUpdateResetPreview,
  type PreviewOperationAggregate,
} from '../../apps/api/dist/owner/infrastructure/replay-update-reset-preview.js';

const GIB = 1073741824n;
const packages = Array.from({ length: 25 }, (_, index) => ({
  id: String(index + 1),
  packageBytes: ((50n + BigInt(index)) * GIB).toString(),
  durationDays: 30,
  amountToman: String(100000 + index * 2000),
}));
const memberships = Array.from({ length: 153 }, (_, index) => ({
  billingAdminId: String(index + 1),
  groupId: '99',
}));
const assignments = packages.map((pkg) => ({
  id: pkg.id,
  targetKind: 'GROUP' as const,
  groupId: '99',
  billingAdminId: null,
  packageId: pkg.id,
  rateTomanPerGiB: null,
}));
const ingestion = {
  batchCount: '15914',
  childCount: '64135',
  unfinishedBatches: '0',
};
function operation(
  kind: PreviewOperationAggregate['kind'],
  overrides: Partial<PreviewOperationAggregate> = {},
): PreviewOperationAggregate {
  return {
    kind,
    dataLimitBytes: packages[0]!.packageBytes,
    previousBytes: kind === 'UPDATE_ONLY' ? (50n * GIB).toString() : null,
    onHoldDurationSeconds: '2592000',
    eventStatus: 'READY_FOR_ACCOUNTING',
    counterpartStatus:
      kind === 'RENEWAL' || kind === 'RESET_WITH_UPDATE_CONTEXT'
        ? 'READY_FOR_ACCOUNTING'
        : null,
    previousEventStatus: kind === 'UPDATE_ONLY' ? 'READY_FOR_ACCOUNTING' : null,
    orderedPrevious: true,
    ambiguousCounterpart: false,
    durationConflict: false,
    boundaryFirstPair: false,
    eventCount: 1,
    ...overrides,
  };
}
function quote(operations: PreviewOperationAggregate[], catalog = packages) {
  const renewals = operations
    .filter((row) => row.kind === 'RENEWAL')
    .reduce((sum, row) => sum + row.eventCount, 0);
  const documentedResets = operations
    .filter((row) => row.kind === 'RESET_WITH_UPDATE_CONTEXT')
    .reduce((sum, row) => sum + row.eventCount, 0);
  const updates = operations
    .filter((row) => row.kind === 'UPDATE_ONLY')
    .reduce((sum, row) => sum + row.eventCount, renewals + documentedResets);
  const resets = operations
    .filter((row) => row.kind === 'RESET_ONLY')
    .reduce((sum, row) => sum + row.eventCount, renewals + documentedResets);
  const base = evaluateReplayStaticCatalog(
    catalog,
    memberships,
    assignments,
    [],
    [
      { action: 'user_updated', eventCount: updates },
      { action: 'data_usage_reset', eventCount: resets },
    ],
    'Asia/Tehran',
    ingestion,
  );
  return evaluateReplayUpdateResetPreview(base, operations, 120);
}

describe('FP-006/007 combined read-only accounting preview', () => {
  it('prices a uniquely evidenced unchanged-Update Reset once and holds contradictory duration', () => {
    const result = quote([
      operation('RESET_WITH_UPDATE_CONTEXT'),
      operation('RESET_WITH_UPDATE_CONTEXT', { durationConflict: true }),
      operation('RESET_WITH_UPDATE_CONTEXT', {
        counterpartStatus: 'NEEDS_REVIEW',
      }),
      operation('RESET_WITH_UPDATE_CONTEXT', { orderedPrevious: false }),
      operation('RESET_WITH_UPDATE_CONTEXT', {
        onHoldDurationSeconds: null,
      }),
    ]);
    expect(result).toMatchObject({
      updateEventCount: 5,
      resetEventCount: 5,
      pairedResetContextCount: 5,
      pricedResetContextCount: 1,
      pricedRenewalCount: 0,
      pricedStandaloneResetCount: 0,
      pricedUpdateOnlyCount: 0,
      heldOperationCount: 4,
      updateResetSubtotalToman: '100000',
    });
    expect(
      Object.fromEntries(
        result.heldReasons.map((row) => [row.code, row.count]),
      ),
    ).toEqual({
      AMBIGUOUS_STATE_ORDER: 1,
      DURATION_CONFLICT: 1,
      MISSING_DURATION: 1,
      SOURCE_NEEDS_REVIEW: 1,
    });
  });

  it('prices one renewal, one positive delta and one standalone reset exactly once', () => {
    const operations = [
      operation('RENEWAL'),
      operation('UPDATE_ONLY', {
        dataLimitBytes: (100n * GIB).toString(),
      }),
      operation('RESET_ONLY'),
      operation('UPDATE_ONLY', { dataLimitBytes: (25n * GIB).toString() }),
      operation('UPDATE_ONLY'),
    ];
    const result = quote(operations);
    expect(result).toMatchObject({
      mode: 'HISTORICAL_UPDATE_RESET_PREVIEW',
      postingScope: 'NONE',
      completeAccounting: false,
      pairedRenewalCount: 1,
      updateEventCount: 4,
      resetEventCount: 2,
      pricedRenewalCount: 1,
      pricedUpdateOnlyCount: 1,
      pricedStandaloneResetCount: 1,
      decreaseUpdateCount: 1,
      unchangedUpdateCount: 1,
      heldOperationCount: 0,
      updateResetSubtotalToman: '300000',
    });
    expect(result.packageBreakdown[0]).toMatchObject({
      pricedOperationCount: 3,
      subtotalToman: '300000',
    });
  });

  it('counts boundary-first Reset pairs once and still holds uncertain source or duration', () => {
    const result = quote([
      operation('RESET_WITH_UPDATE_CONTEXT', { boundaryFirstPair: true }),
      operation('RENEWAL', { boundaryFirstPair: true }),
      operation('RESET_WITH_UPDATE_CONTEXT', {
        boundaryFirstPair: true,
        durationConflict: true,
      }),
      operation('RENEWAL', {
        boundaryFirstPair: true,
        counterpartStatus: 'NEEDS_REVIEW',
      }),
      operation('RENEWAL', {
        boundaryFirstPair: true,
        onHoldDurationSeconds: null,
      }),
    ]);
    expect(result).toMatchObject({
      boundaryFirstPairCount: 5,
      pricedBoundaryFirstPairCount: 2,
      pricedResetContextCount: 1,
      pricedRenewalCount: 1,
      heldOperationCount: 3,
      updateResetSubtotalToman: '200000',
    });
    expect(result.heldReasons).toEqual([
      { code: 'DURATION_CONFLICT', count: 1 },
      { code: 'MISSING_DURATION', count: 1 },
      { code: 'SOURCE_NEEDS_REVIEW', count: 1 },
    ]);
  });

  it('holds ambiguous 1-to-many correlation, unknown previous state and absent duration', () => {
    const result = quote([
      operation('RENEWAL', { onHoldDurationSeconds: null }),
      operation('UPDATE_ONLY', {
        ambiguousCounterpart: true,
        previousBytes: null,
      }),
      operation('RESET_ONLY', { ambiguousCounterpart: true }),
      operation('UPDATE_ONLY', { previousBytes: null }),
      operation('UPDATE_ONLY', {
        previousBytes: (50n * GIB).toString(),
        dataLimitBytes: (100n * GIB).toString(),
        onHoldDurationSeconds: null,
      }),
    ]);
    expect(result.updateResetSubtotalToman).toBe('0');
    expect(result.heldOperationCount).toBe(5);
    expect(
      Object.fromEntries(result.heldReasons.map((r) => [r.code, r.count])),
    ).toEqual({
      AMBIGUOUS_CORRELATION: 2,
      MISSING_DURATION: 2,
      PREVIOUS_STATE_MISSING: 1,
    });
    expect(result.priorSnapshotMissingCount).toBe(2);
    expect(result.ambiguousUpdateCount).toBe(1);
    expect(result.ambiguousResetCount).toBe(1);
  });

  it('holds source-needs-review, tied previous time and invalid shapes without guessing', () => {
    const result = quote([
      operation('RENEWAL', { counterpartStatus: 'NEEDS_REVIEW' }),
      operation('UPDATE_ONLY', { orderedPrevious: false }),
      operation('RESET_ONLY', { dataLimitBytes: '0' }),
      operation('RESET_ONLY', { onHoldDurationSeconds: '1' }),
    ]);
    expect(result.updateResetSubtotalToman).toBe('0');
    expect(
      Object.fromEntries(result.heldReasons.map((r) => [r.code, r.count])),
    ).toEqual({
      AMBIGUOUS_STATE_ORDER: 1,
      MISSING_DURATION: 1,
      SOURCE_NEEDS_REVIEW: 1,
      UNEXPECTED_UNLIMITED: 1,
    });
  });

  it('fails closed on incomplete catalog, mismatched update/reset counts and bad window', () => {
    const rows = [operation('RENEWAL')];
    expect(quote(rows, packages.slice(1)).updateResetSubtotalToman).toBeNull();
    const base = evaluateReplayStaticCatalog(
      packages,
      memberships,
      assignments,
      [],
      [{ action: 'user_updated', eventCount: 2 }],
      'Asia/Tehran',
      ingestion,
    );
    expect(
      evaluateReplayUpdateResetPreview(base, rows, 120)
        .updateResetSubtotalToman,
    ).toBeNull();
    expect(() => evaluateReplayUpdateResetPreview(base, rows, 0)).toThrow(
      'INVALID_CORRELATION_WINDOW',
    );
    expect(
      quote([operation('UPDATE_ONLY', { boundaryFirstPair: true })])
        .ingestionReady,
    ).toBe(false);
  });
});

describe('Owner-only update/reset replay route', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('rejects unauthenticated/parameterized calls; exposes aggregate-only non-posting data', async () => {
    const auth = {
      authenticated: (token: string | null) =>
        Promise.resolve(token === 'synthetic-session'),
    };
    const replayUpdateResetPreview = vi.fn(() =>
      Promise.resolve(quote([operation('RENEWAL')])),
    );
    app = await createOwnerApi(
      auth as never,
      { ready: async () => {} } as never,
      'https://panel.fairisfair.ir',
      undefined,
      undefined,
      undefined,
      { replayUpdateResetPreview } as never,
    );
    const url =
      '/api/v1/owner/operations/accounting/replay-update-reset-preview';
    expect((await app.inject(url)).statusCode).toBe(401);
    const headers = { cookie: `${COOKIE}=synthetic-session` };
    expect(
      (await app.inject({ url: `${url}?source=primary`, headers })).statusCode,
    ).toBe(400);
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
    });
    expect(response.body).not.toContain('synthetic-admin');
    expect(replayUpdateResetPreview).toHaveBeenCalledTimes(1);
  });
});

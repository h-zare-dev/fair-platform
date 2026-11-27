import { afterEach, describe, expect, it, vi } from 'vitest';
import { localJalaliDate } from '@fair-platform/calendar';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import {
  evaluateReplayStaticCatalog,
  type PreviewAssignment,
  type PreviewActionAggregate,
  type PreviewCreateAggregate,
  type PreviewIngestion,
} from '../../apps/api/dist/owner/infrastructure/replay-preview.js';
import { PostgresShadowReader } from '../../apps/api/dist/owner/infrastructure/shadow-reader.js';

const GIB = 1073741824n;
const packages = Array.from({ length: 25 }, (_, i) => ({
  id: String(i + 1),
  packageBytes: (BigInt(50 + i) * GIB).toString(),
  durationDays: 30,
  amountToman: String(250000 + i * 1000),
}));
const memberships = Array.from({ length: 153 }, (_, i) => ({
  billingAdminId: String(i + 1),
  groupId: '77',
}));
const assignments = packages.map((pkg, i) => ({
  id: String(i + 1),
  targetKind: 'GROUP' as const,
  groupId: '77',
  billingAdminId: null,
  packageId: pkg.id,
  rateTomanPerGiB: null,
}));
const ingestion: PreviewIngestion = {
  batchCount: '15914',
  childCount: '64135',
  unfinishedBatches: '0',
};

interface SyntheticEvent {
  action: string;
  billingAdminId: string;
  username: string;
  sourceTimestamp: Date;
  dataLimitBytes: string;
  onHoldDurationSeconds: string | null;
  eventStatus: string;
  activeTwoDayDateCandidate: boolean;
}
function event(overrides: Partial<SyntheticEvent> = {}): SyntheticEvent {
  return {
    action: 'user_created',
    billingAdminId: '1',
    username: 'synthetic-user',
    sourceTimestamp: new Date('2026-10-10T00:00:00Z'),
    dataLimitBytes: packages[0]!.packageBytes,
    onHoldDurationSeconds: '2592000',
    eventStatus: 'READY_FOR_ACCOUNTING',
    activeTwoDayDateCandidate: false,
    ...overrides,
  };
}

function aggregateEvents(events: readonly SyntheticEvent[]): {
  creates: PreviewCreateAggregate[];
  actions: PreviewActionAggregate[];
} {
  const actionCounts = new Map<string, number>();
  const correctionCounts = new Map<string, number>();
  for (const row of events) {
    actionCounts.set(row.action, (actionCounts.get(row.action) ?? 0) + 1);
    if (row.action === 'user_created' || row.action === 'user_deleted') {
      const key = `${row.username}\0${localJalaliDate(row.sourceTimestamp, 'Asia/Tehran')}`;
      correctionCounts.set(key, (correctionCounts.get(key) ?? 0) + 1);
    }
  }
  const shapes = new Map<string, PreviewCreateAggregate>();
  for (const row of events.filter((v) => v.action === 'user_created')) {
    const key = `${row.username}\0${localJalaliDate(row.sourceTimestamp, 'Asia/Tehran')}`;
    const group: PreviewCreateAggregate = {
      billingAdminId: row.billingAdminId,
      dataLimitBytes: row.dataLimitBytes,
      onHoldDurationSeconds: row.onHoldDurationSeconds,
      eventStatus: row.eventStatus,
      isCorrection: (correctionCounts.get(key) ?? 0) > 1,
      activeTwoDayDateCandidate: row.activeTwoDayDateCandidate,
      eventCount: 1,
    };
    const shape = JSON.stringify(group);
    const existing = shapes.get(shape);
    if (existing) existing.eventCount++;
    else shapes.set(shape, group);
  }
  return {
    creates: [...shapes.values()],
    actions: [...actionCounts.entries()].map(([action, eventCount]) => ({
      action,
      eventCount,
    })),
  };
}

function preview(
  events: SyntheticEvent[],
  overrides: {
    catalog?: typeof packages;
    members?: typeof memberships;
    rules?: PreviewAssignment[];
    inbox?: PreviewIngestion;
  } = {},
) {
  const { creates, actions } = aggregateEvents(events);
  return evaluateReplayStaticCatalog(
    overrides.catalog ?? packages,
    overrides.members ?? memberships,
    overrides.rules ?? assignments,
    creates,
    actions,
    'Asia/Tehran',
    overrides.inbox ?? ingestion,
  );
}

describe('30-day fixed catalog historical preview (never posting)', () => {
  it('prices exact Create in integer Toman and excludes other actions', () => {
    const result = preview([
      event(),
      event({ username: 'second-user', billingAdminId: '153' }),
      event({ action: 'user_updated', username: 'other-user' }),
      event({ action: 'user_reset', username: 'another-user' }),
    ]);
    expect(result).toMatchObject({
      source: 'replay-30d',
      postingScope: 'NONE',
      completeAccounting: false,
      configurationReady: true,
      ingestionReady: true,
      createEventCount: 2,
      pricedCreateCount: 2,
      heldCreateCount: 0,
      createOnlySubtotalToman: '500000',
      unclassifiedEventCount: 2,
    });
    expect(result.packageBreakdown).toHaveLength(25);
    expect(result.packageBreakdown[0]).toMatchObject({
      packageBytes: packages[0]!.packageBytes,
      durationDays: 30,
      amountToman: '250000',
      pricedCreateCount: 2,
      subtotalToman: '500000',
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-user');
  });

  it('holds unknown packages, missing duration, unlimited and unready events', () => {
    const result = preview([
      event({ username: 'shape', dataLimitBytes: '123' }),
      event({ username: 'missing', onHoldDurationSeconds: null }),
      event({ username: 'unlimited', dataLimitBytes: '0' }),
      event({ username: 'review', eventStatus: 'NEEDS_REVIEW' }),
    ]);
    expect(result.pricedCreateCount).toBe(0);
    expect(result.heldCreateCount).toBe(4);
    expect(result.createOnlySubtotalToman).toBe('0');
    expect(
      Object.fromEntries(result.heldReasons.map((r) => [r.code, r.count])),
    ).toEqual({
      AMBIGUOUS_CORRELATION: 1,
      MISSING_DURATION: 1,
      PRICING_MISSING: 1,
      UNEXPECTED_UNLIMITED: 1,
    });
  });

  it('holds same-day create/delete corrections even if the admin changed', () => {
    const result = preview([
      event(),
      event({ action: 'user_deleted', billingAdminId: '2' }),
    ]);
    expect(result.heldReasons).toContainEqual({
      code: 'AMBIGUOUS_CORRECTION',
      count: 1,
    });
    expect(result.createOnlySubtotalToman).toBe('0');
  });

  it('cannot quote incomplete or inconsistent catalog or group coverage', () => {
    const invalidCases = [
      { catalog: packages.slice(0, 24) },
      { members: memberships.slice(0, 152) },
      {
        members: memberships.map((m, i) =>
          i === 0 ? { ...m, groupId: '88' } : m,
        ),
      },
      { rules: assignments.slice(0, 24) },
      {
        rules: [
          ...assignments.slice(0, 24),
          { ...assignments[24]!, targetKind: 'ADMIN' as const },
        ],
      },
      {
        catalog: packages.map((pkg, i) =>
          i === 1 ? { ...pkg, packageBytes: packages[0]!.packageBytes } : pkg,
        ),
      },
    ];
    for (const invalid of invalidCases) {
      const result = preview([event()], invalid);
      expect(result.configurationReady).toBe(false);
      expect(result.pricedCreateCount).toBe(0);
      expect(result.createOnlySubtotalToman).toBeNull();
      expect(result.packageBreakdown).toEqual([]);
      expect(result.heldReasons).toContainEqual({
        code: 'CATALOG_COVERAGE_INCOMPLETE',
        count: 1,
      });
    }
  });

  it('blocks a partial, failed or changed archive', () => {
    for (const inbox of [
      { ...ingestion, batchCount: '15913' },
      { ...ingestion, childCount: '64134' },
      { ...ingestion, unfinishedBatches: '1' },
    ]) {
      const result = preview([event()], { inbox });
      expect(result.ingestionReady).toBe(false);
      expect(result.pricedCreateCount).toBe(0);
      expect(result.createOnlySubtotalToman).toBeNull();
      expect(result.heldReasons).toContainEqual({
        code: 'REPLAY_INGESTION_INCOMPLETE',
        count: 1,
      });
    }
  });

  it('preserves an exact integer quote above JS safe integer limits', () => {
    const exact = '9007199254740993';
    const result = preview([event(), event({ username: 'other-one' })], {
      catalog: packages.map((pkg, i) =>
        i === 0 ? { ...pkg, amountToman: exact } : pkg,
      ),
    });
    expect(result.createOnlySubtotalToman).toBe('18014398509481986');
    expect(result.packageBreakdown[0]?.pricedCreateCount).toBe(2);
  });

  it('rejects inconsistent action totals and Create aggregate counts', () => {
    const { creates, actions } = aggregateEvents([event()]);
    const result = evaluateReplayStaticCatalog(
      packages,
      memberships,
      assignments,
      creates.map((row) => ({ ...row, eventCount: 2 })),
      actions,
      'Asia/Tehran',
      ingestion,
    );
    expect(result.ingestionReady).toBe(false);
    expect(result.createOnlySubtotalToman).toBeNull();
  });

  it('never prices a Create outside the 153 admin memberships', () => {
    const result = preview([event({ billingAdminId: '999' })]);
    expect(result.configurationReady).toBe(true);
    expect(result.heldReasons).toContainEqual({
      code: 'ADMIN_MEMBERSHIP_MISSING',
      count: 1,
    });
    expect(result.createOnlySubtotalToman).toBe('0');
  });

  it('separates an Owner-attested all-admin what-if quote from unmatched replay identities', () => {
    const result = preview([
      event({ username: 'matched' }),
      event({ username: 'archive-only', billingAdminId: '999' }),
      event({
        username: 'no-duration',
        billingAdminId: '998',
        onHoldDurationSeconds: null,
      }),
      event({
        username: 'other-action',
        action: 'user_updated',
        billingAdminId: '997',
      }),
    ]);
    expect(result).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
      pricedCreateCount: 1,
      heldCreateCount: 2,
      createOnlySubtotalToman: '250000',
      ownerAttestedWhatIf: {
        assumption: 'ALL_REPLAY_ADMINS_USE_SINGLE_CONFIGURED_GROUP',
        allCreateIdsMatchMemberships: false,
        identityMatchedCreateCount: 1,
        identityUnmatchedCreateCount: 2,
        pricedCreateCount: 2,
        heldCreateCount: 1,
        createOnlySubtotalToman: '500000',
        heldReasons: [{ code: 'MISSING_DURATION', count: 1 }],
      },
    });
    expect(result.ownerAttestedWhatIf.packageBreakdown[0]).toMatchObject({
      pricedCreateCount: 2,
      subtotalToman: '500000',
    });
    expect(JSON.stringify(result)).not.toContain('archive-only');
  });

  it('adds only Owner-attested active half-GiB two-day date candidates to the non-posting what-if', () => {
    const trialCatalog = packages.map((pkg, i) =>
      i === 24
        ? {
            ...pkg,
            packageBytes: (GIB / 2n).toString(),
            durationDays: 2,
            amountToman: '1000',
          }
        : pkg,
    );
    const candidate = {
      dataLimitBytes: (GIB / 2n).toString(),
      onHoldDurationSeconds: null,
      activeTwoDayDateCandidate: true,
    };
    const result = preview(
      [
        event({ ...candidate, username: 'one', billingAdminId: '999' }),
        event({ ...candidate, username: 'two', billingAdminId: '998' }),
        event({
          ...candidate,
          username: 'no-date',
          activeTwoDayDateCandidate: false,
        }),
        event({
          ...candidate,
          username: 'wrong-size',
          dataLimitBytes: GIB.toString(),
        }),
        event({
          ...candidate,
          username: 'needs-review',
          eventStatus: 'NEEDS_REVIEW',
        }),
        event({ ...candidate, username: 'deleted-same-day' }),
        event({ action: 'user_deleted', username: 'deleted-same-day' }),
      ],
      { catalog: trialCatalog },
    );
    expect(result).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
      pricedCreateCount: 0,
      heldCreateCount: 6,
      createOnlySubtotalToman: '0',
      ownerAttestedWhatIf: {
        pricedCreateCount: 2,
        heldCreateCount: 4,
        activeTwoDayInferredPricedCreateCount: 2,
        createOnlySubtotalToman: '2000',
      },
    });
    expect(result.ownerAttestedWhatIf.packageBreakdown[24]).toMatchObject({
      pricedCreateCount: 2,
      subtotalToman: '2000',
    });
    expect(result.ownerAttestedWhatIf.heldReasons).toEqual(
      expect.arrayContaining([
        { code: 'MISSING_DURATION', count: 2 },
        { code: 'AMBIGUOUS_CORRELATION', count: 1 },
        { code: 'AMBIGUOUS_CORRECTION', count: 1 },
      ]),
    );
  });

  it('does not infer half-GiB without a matching exact package or complete catalog', () => {
    const half = (GIB / 2n).toString();
    const result = preview([
      event({
        dataLimitBytes: half,
        onHoldDurationSeconds: null,
        activeTwoDayDateCandidate: true,
      }),
    ]);
    expect(result.ownerAttestedWhatIf.pricedCreateCount).toBe(0);
    expect(
      result.ownerAttestedWhatIf.activeTwoDayInferredPricedCreateCount,
    ).toBe(0);
    expect(result.ownerAttestedWhatIf.heldReasons).toContainEqual({
      code: 'PRICING_MISSING',
      count: 1,
    });
  });

  it('never invents a what-if subtotal if catalog or replay coverage is incomplete', () => {
    const result = preview([event({ billingAdminId: '999' })], {
      members: memberships.slice(0, 152),
    });
    expect(result.ownerAttestedWhatIf.createOnlySubtotalToman).toBeNull();
    expect(result.ownerAttestedWhatIf.pricedCreateCount).toBe(0);
    expect(result.ownerAttestedWhatIf.packageBreakdown).toEqual([]);
  });

  it('keeps verified and hypothetical sums identical when every replay admin matches', () => {
    const result = preview([
      event(),
      event({ username: 'other', billingAdminId: '153' }),
    ]);
    expect(result.ownerAttestedWhatIf.allCreateIdsMatchMemberships).toBe(true);
    expect(result.ownerAttestedWhatIf.identityUnmatchedCreateCount).toBe(0);
    expect(result.ownerAttestedWhatIf.createOnlySubtotalToman).toBe(
      result.createOnlySubtotalToman,
    );
    expect(result.ownerAttestedWhatIf.pricedCreateCount).toBe(
      result.pricedCreateCount,
    );
  });
});

describe('read-only replay preview query boundary', () => {
  it('uses primary for the 25 prices and replay-30d for history, with only SELECT queries', async () => {
    const query = vi.fn((sql: string, _params?: unknown[]) => {
      void _params;
      if (sql.includes('FROM fair_atomic_packages'))
        return Promise.resolve(packages);
      if (sql.includes('FROM fair_admin_group_memberships'))
        return Promise.resolve(memberships);
      if (sql.includes('FROM fair_tariff_assignments'))
        return Promise.resolve(assignments);
      if (sql.includes('FROM pasarguard_webhook_batches'))
        return Promise.resolve([ingestion]);
      if (sql.includes('WITH corrected'))
        return Promise.resolve(aggregateEvents([event()]).creates);
      if (sql.includes('FROM pasarguard_events'))
        return Promise.resolve(aggregateEvents([event()]).actions);
      throw new Error('UNEXPECTED_SQL');
    });
    const reader = new PostgresShadowReader({ query } as never, 'Asia/Tehran');
    const result = await reader.replayPreview();
    expect(result.createOnlySubtotalToman).toBe('250000');
    expect(query).toHaveBeenCalledTimes(6);
    for (const [sql, params] of query.mock.calls) {
      expect(sql.trimStart()).toMatch(/^(SELECT|WITH corrected)/);
      expect(sql).toMatch(/LIMIT (501|2001|70001|101)|COUNT\(\*\)/);
      // Individual usernames/timestamps must be processed by SQL grouping,
      // never transferred to the API process for a 64K-event replay.
      if (sql.includes('WITH corrected')) {
        expect(sql).toContain('HAVING COUNT(*)>1');
        expect(sql).toContain('AT TIME ZONE $2::text');
        expect(params).toEqual(['replay-30d', 'Asia/Tehran']);
        continue;
      }
      expect(params).toEqual([
        /FROM fair_(atomic_packages|admin_group_memberships|tariff_assignments)/.test(
          sql,
        )
          ? 'primary'
          : 'replay-30d',
      ]);
    }
  });
});

describe('Owner-only replay preview HTTP', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('requires Owner session, rejects parameters and exposes aggregate-only response', async () => {
    const auth = {
      authenticated: (token: string | null) =>
        Promise.resolve(token === 'synthetic-session'),
    };
    const replayPreview = vi.fn(() => Promise.resolve(preview([event()])));
    app = await createOwnerApi(
      auth as never,
      { ready: async () => {} } as never,
      'https://panel.fairisfair.ir',
      undefined,
      undefined,
      undefined,
      { replayPreview } as never,
    );
    const url = '/api/v1/owner/operations/accounting/replay-preview';
    expect((await app.inject(url)).statusCode).toBe(401);
    expect(replayPreview).not.toHaveBeenCalled();
    const headers = { cookie: `${COOKIE}=synthetic-session` };
    expect(
      (await app.inject({ url: `${url}?source=primary`, headers })).statusCode,
    ).toBe(400);
    expect(replayPreview).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      postingScope: 'NONE',
      completeAccounting: false,
    });
    expect(response.body).not.toContain('synthetic-user');
    expect(replayPreview).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import {
  evaluateReplayStaticCatalog,
  type PreviewAssignment,
  type PreviewEvent,
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

function event(overrides: Partial<PreviewEvent> = {}): PreviewEvent {
  return {
    action: 'user_created',
    billingAdminId: '1',
    username: 'synthetic-user',
    sourceTimestamp: new Date('2026-10-10T00:00:00Z'),
    dataLimitBytes: packages[0]!.packageBytes,
    onHoldDurationSeconds: '2592000',
    eventStatus: 'READY_FOR_ACCOUNTING',
    ...overrides,
  };
}

function preview(
  events: PreviewEvent[],
  overrides: {
    catalog?: typeof packages;
    members?: typeof memberships;
    rules?: PreviewAssignment[];
    inbox?: PreviewIngestion;
  } = {},
) {
  return evaluateReplayStaticCatalog(
    overrides.catalog ?? packages,
    overrides.members ?? memberships,
    overrides.rules ?? assignments,
    events,
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
    const result = preview([event()], {
      catalog: packages.map((pkg, i) =>
        i === 0 ? { ...pkg, amountToman: exact } : pkg,
      ),
    });
    expect(result.createOnlySubtotalToman).toBe(exact);
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
      if (sql.includes('FROM pasarguard_events'))
        return Promise.resolve([event()]);
      throw new Error('UNEXPECTED_SQL');
    });
    const reader = new PostgresShadowReader({ query } as never, 'Asia/Tehran');
    const result = await reader.replayPreview();
    expect(result.createOnlySubtotalToman).toBe('250000');
    expect(query).toHaveBeenCalledTimes(5);
    for (const [sql, params] of query.mock.calls) {
      expect(sql.trimStart().startsWith('SELECT')).toBe(true);
      expect(sql).toMatch(/LIMIT (501|2001|70001)|COUNT\(\*\)/);
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

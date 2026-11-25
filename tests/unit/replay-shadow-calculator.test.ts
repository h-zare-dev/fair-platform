import { describe, expect, it } from 'vitest';
import {
  calculateReplayShadow,
  replayManualReviewKey,
  type ReplayFixedPrice,
  type ReplaySourceEvent,
} from '../../apps/api/dist/owner/infrastructure/replay-shadow-calculator.js';

const GIB = 1073741824n;
const prices: ReplayFixedPrice[] = [
  {
    packageId: '1',
    bytes: (50n * GIB).toString(),
    days: 30,
    amountToman: '100000',
  },
  {
    packageId: '2',
    bytes: (100n * GIB).toString(),
    days: 30,
    amountToman: '200000',
  },
  {
    packageId: '3',
    bytes: (50n * GIB).toString(),
    days: 60,
    amountToman: '150000',
  },
  {
    packageId: '4',
    bytes: (GIB / 2n).toString(),
    days: 2,
    amountToman: '1000',
  },
];
const options = {
  timeZone: 'UTC',
  correlationWindowSeconds: 600,
  deleteCreditEnabled: false,
};
function event(
  id: number,
  action: string,
  bytes = 50n * GIB,
  overrides: Partial<ReplaySourceEvent> = {},
): ReplaySourceEvent {
  return {
    id: String(id),
    action,
    billingAdminId: '17',
    externalUserId: '900',
    sourceTimestamp: `2026-11-20T12:${String(id).padStart(2, '0')}:00.000000Z`,
    dataLimitBytes: bytes.toString(),
    durationSeconds: '2592000',
    eventStatus: 'READY_FOR_ACCOUNTING',
    userStatus: 'on_hold',
    sourceUserCreatedAt: null,
    sourceUserExpiresAt: null,
    ...overrides,
  };
}
const run = (events: ReplaySourceEvent[], deleteCreditEnabled = false) =>
  calculateReplayShadow(events, prices, { ...options, deleteCreditEnabled });

describe('Owner-attested historical SHADOW journal', () => {
  it('charges each verified Create and does not invent a credit for Delete by default', () => {
    const result = run([event(1, 'user_created'), event(2, 'user_deleted')]);
    expect(result.entries).toMatchObject([
      { kind: 'CREATE', amountToman: '100000' },
    ]);
    expect(result.days).toMatchObject([
      {
        status: 'SHADOW_READY',
        totalChargeToman: '100000',
        totalCreditToman: '0',
        netToman: '100000',
      },
    ]);
    expect(result.ignoredEvents).toBe(1);
  });

  it('ENV-on credits exactly the last provable purchase, regardless of elapsed days', () => {
    const result = run(
      [
        event(1, 'user_created'),
        event(2, 'data_usage_reset', 100n * GIB, {
          sourceTimestamp: '2026-11-21T12:01:00Z',
        }),
        event(3, 'user_deleted', 100n * GIB, {
          sourceTimestamp: '2026-12-05T13:00:00Z',
        }),
        event(4, 'user_deleted', 100n * GIB, {
          sourceTimestamp: '2026-12-06T13:00:00Z',
        }),
      ],
      true,
    );
    expect(result.entries.map((e) => [e.entryType, e.amountToman])).toEqual([
      ['CHARGE', '100000'],
      ['CHARGE', '200000'],
      ['CREDIT', '200000'],
    ]);
    expect(result.entries[2]?.referenceOperationKey).toBe(
      result.entries[1]?.operationKey,
    );
    expect(
      result.days.find((day) => day.localDay === '1405-09-14'),
    ).toMatchObject({
      totalCreditToman: '200000',
      netToman: '-200000',
    });
  });

  it('pairs Reset before Update with proven 30-to-60-day change once', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'data_usage_reset'),
      event(3, 'user_updated', 50n * GIB, { durationSeconds: '5184000' }),
    ]);
    expect(result.entries.map((e) => e.kind)).toEqual(['CREATE', 'RENEWAL']);
    expect(result.entries[1]?.amountToman).toBe('150000');
    expect(result.holds).toHaveLength(0);
  });

  it('prices the NEW Update package even when a Reset with old 30-day state arrives afterward', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'user_updated', 50n * GIB, { durationSeconds: '5184000' }),
      event(3, 'data_usage_reset', 50n * GIB, { durationSeconds: '2592000' }),
    ]);
    expect(result.entries.map((e) => [e.kind, e.amountToman])).toEqual([
      ['CREATE', '100000'],
      ['RENEWAL', '150000'],
    ]);
    expect(result.holds).toHaveLength(0);
  });

  it('blocks an old-duration Reset without a verified previous state', () => {
    const result = run([
      event(2, 'user_updated', 50n * GIB, { durationSeconds: '5184000' }),
      event(3, 'data_usage_reset', 50n * GIB, { durationSeconds: '2592000' }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.holds.map((h) => h.code)).toEqual(['DURATION_CONFLICT']);
  });

  it('prices two independent adjacent Reset/Update cycles twice', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'data_usage_reset'),
      event(3, 'user_updated'),
      event(4, 'data_usage_reset'),
      event(5, 'user_updated'),
    ]);
    expect(result.entries.filter((e) => e.kind === 'RENEWAL')).toHaveLength(2);
    expect(result.days[0]?.totalChargeToman).toBe('300000');
  });

  it('pairs two source events sharing the same timestamp, independent of webhook arrival', () => {
    const timestamp = '2026-11-20T12:02:00Z';
    const result = run([
      event(1, 'user_created'),
      event(2, 'data_usage_reset', 50n * GIB, { sourceTimestamp: timestamp }),
      event(3, 'user_updated', 50n * GIB, { sourceTimestamp: timestamp }),
    ]);
    expect(result.entries.filter((e) => e.kind === 'RENEWAL')).toHaveLength(1);
    expect(result.holds).toHaveLength(0);
  });

  it('holds same-day Reset/Update delayed beyond ten minutes, never charges them twice', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'data_usage_reset', 50n * GIB, {
        sourceTimestamp: '2026-11-20T12:02:00Z',
      }),
      event(3, 'user_updated', 50n * GIB, {
        sourceTimestamp: '2026-11-20T12:15:00Z',
      }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.days[0]?.status).toBe('PENDING_REVIEW');
    expect(result.holds.map((h) => h.code)).toEqual([
      'CORRELATION_OUTSIDE_WINDOW',
      'CORRELATION_OUTSIDE_WINDOW',
    ]);
  });

  it('prices positive standalone Update delta, ignores decrease, and preserves missing prior state', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'user_updated', 100n * GIB),
      event(3, 'user_updated', 50n * GIB, {
        sourceTimestamp: '2026-11-21T13:00:00Z',
      }),
      event(4, 'user_updated', 100n * GIB, {
        sourceTimestamp: '2026-11-21T14:00:00Z',
      }),
    ]);
    expect(result.entries.map((e) => e.kind)).toEqual([
      'CREATE',
      'UPDATE_INCREASE',
      'UPDATE_INCREASE',
    ]);
    expect(result.ignoredEvents).toBe(1);
    const missing = run([event(1, 'user_updated', 100n * GIB)]);
    expect(missing.holds.map((h) => h.code)).toEqual([
      'PREVIOUS_STATE_MISSING',
    ]);
    expect(missing.entries).toHaveLength(0);
  });

  it('holds ambiguous chains and does not post other charges for the affected admin/day', () => {
    const result = run([
      event(1, 'user_created'),
      event(2, 'data_usage_reset'),
      event(3, 'user_updated'),
      event(4, 'data_usage_reset'),
    ]);
    expect(result.days[0]).toMatchObject({
      status: 'PENDING_REVIEW',
      entryCount: 0,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.holds.map((h) => h.code)).toEqual([
      'AMBIGUOUS_CORRELATION',
      'AMBIGUOUS_CORRELATION',
      'AMBIGUOUS_CORRELATION',
    ]);
  });

  it('isolates blocking exceptions to an admin/day and refuses credit against an unposted purchase', () => {
    const result = run(
      [
        event(1, 'user_created', 50n * GIB, { durationSeconds: null }),
        event(2, 'user_deleted', 50n * GIB, {
          sourceTimestamp: '2026-11-21T12:00:00Z',
        }),
        event(3, 'user_created', 50n * GIB, {
          billingAdminId: '18',
          sourceTimestamp: '2026-11-20T12:03:00Z',
        }),
      ],
      true,
    );
    expect(
      result.holds.some((h) => h.code === 'CREDIT_SOURCE_NOT_PROVEN'),
    ).toBe(true);
    expect(result.entries).toMatchObject([
      {
        billingAdminId: '18',
        amountToman: '100000',
      },
    ]);
  });

  it('never refunds an older purchase when a newer operation is unproven', () => {
    const result = run(
      [
        event(1, 'user_created'),
        event(2, 'data_usage_reset', 100n * GIB, {
          sourceTimestamp: '2026-11-21T12:02:00Z',
          durationSeconds: null,
        }),
        event(3, 'user_deleted', 100n * GIB, {
          sourceTimestamp: '2026-11-22T12:03:00Z',
        }),
      ],
      true,
    );
    expect(result.entries).toMatchObject([
      { kind: 'CREATE', entryType: 'CHARGE' },
    ]);
    expect(result.entries.some((line) => line.entryType === 'CREDIT')).toBe(
      false,
    );
    expect(result.holds.map((h) => h.code)).toEqual([
      'MISSING_DURATION',
      'CREDIT_SOURCE_NOT_PROVEN',
    ]);
  });

  it('recognizes only the approved exact active 0.5 GiB / two-day trial', () => {
    const active = event(1, 'user_created', GIB / 2n, {
      userStatus: 'active',
      durationSeconds: null,
      sourceTimestamp: '2026-11-20T12:01:00Z',
      sourceUserCreatedAt: '2026-11-20T12:00:59Z',
      sourceUserExpiresAt: '2026-11-22T12:00:59Z',
    });
    expect(run([active]).entries[0]?.amountToman).toBe('1000');
    expect(
      run([{ ...active, sourceUserExpiresAt: '2026-11-23T12:00:59Z' }]).holds[0]
        ?.code,
    ).toBe('MISSING_DURATION');
  });

  it('fails closed for unknown prices, unverified Next Plan and duplicate source events', () => {
    expect(run([event(1, 'user_created', 300n * GIB)]).holds[0]?.code).toBe(
      'PRICING_MISSING',
    );
    expect(run([event(2, 'data_reset_by_next')]).holds[0]?.code).toBe(
      'NEXT_PLAN_NEEDS_VERIFICATION',
    );
    expect(() =>
      run([event(1, 'user_created'), event(1, 'user_created')]),
    ).toThrow('INVALID_REPLAY_EVENT');
  });
});

it('separates an explicitly approved manual operation without inventing money or blocking priced work', () => {
  const manual = event(1, 'user_created', 50n * GIB, {
    durationSeconds: null,
    fingerprint: 'a'.repeat(64),
  });
  const priced = event(2, 'user_created', 50n * GIB, { externalUserId: '901' });
  const monthlyReset = event(3, 'data_usage_reset', 50n * GIB, {
    externalUserId: '902',
  });
  const otherAdmin = event(4, 'user_created', 50n * GIB, {
    billingAdminId: '18',
    durationSeconds: null,
    fingerprint: manual.fingerprint!,
  });
  const key = replayManualReviewKey('MISSING_DURATION', '17', '900', [
    manual.fingerprint,
  ]);
  expect(key).toBeTruthy();
  const result = calculateReplayShadow(
    [manual, priced, monthlyReset, otherAdmin],
    prices,
    {
      ...options,
      manualReviewKeys: new Set([key!]),
    },
  );
  expect(result.manual).toMatchObject([
    { billingAdminId: '17', reviewKey: key },
  ]);
  expect(result.holds).toMatchObject([
    { billingAdminId: '18', code: 'MISSING_DURATION' },
  ]);
  expect(result.entries.map((line) => line.kind)).toEqual(['CREATE', 'RESET']);
  expect(result.days).toMatchObject([
    { billingAdminId: '17', status: 'SHADOW_READY', netToman: '200000' },
    { billingAdminId: '18', status: 'PENDING_REVIEW', netToman: null },
  ]);
});

import { describe, expect, it } from 'vitest';
import {
  calculateReplayShadow,
  type ReplayFixedPrice,
  type ReplaySourceEvent,
} from '../../apps/api/dist/owner/infrastructure/replay-shadow-calculator.js';

// Deliberately independent price oracle: a simple 2,000 Toman per integer
// GiB is a synthetic fixture, NEVER a fallback for real historical pricing.
const GiB = 1024n ** 3n;
const oracle = (gib: number): string => (BigInt(gib) * 2_000n).toString();
const catalog: ReplayFixedPrice[] = Array.from({ length: 25 }, (_, i) => {
  const gib = 50 * (i + 1);
  return {
    packageId: String(i + 1),
    bytes: (BigInt(gib) * GiB).toString(),
    days: 30,
    amountToman: oracle(gib),
  };
});
const base: ReplaySourceEvent = {
  id: '1',
  action: 'user_created',
  billingAdminId: '17',
  externalUserId: '1',
  sourceTimestamp: '2026-11-20T12:00:00Z',
  dataLimitBytes: (50n * GiB).toString(),
  durationSeconds: '2592000',
  eventStatus: 'READY_FOR_ACCOUNTING',
  userStatus: 'on_hold',
  sourceUserCreatedAt: null,
  sourceUserExpiresAt: null,
};
const settings = {
  timeZone: 'Asia/Tehran',
  correlationWindowSeconds: 600,
  deleteCreditEnabled: false,
};

describe('independent integer-money golden oracle for historical SHADOW audit', () => {
  it('reconciles each of 25 shapes and global Toman total independently', () => {
    const events = catalog.map((price, i): ReplaySourceEvent => ({
      ...base,
      id: String(i + 1),
      billingAdminId: String(i + 20),
      externalUserId: String(i + 100),
      dataLimitBytes: price.bytes,
    }));
    const result = calculateReplayShadow(events, catalog, settings);
    expect(result.holds).toHaveLength(0);
    expect(result.heldCandidates).toHaveLength(0);
    expect(result.entries).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect(result.entries[i]).toMatchObject({
        kind: 'CREATE',
        entryType: 'CHARGE',
        amountToman: oracle((i + 1) * 50),
        packageId: String(i + 1),
      });
    }
    const oracleTotal = Array.from({ length: 25 }, (_, i) =>
      BigInt(oracle((i + 1) * 50)),
    ).reduce((a, b) => a + b, 0n);
    expect(oracleTotal).toBe(32_500_000n);
    expect(
      result.entries.reduce((sum, e) => sum + BigInt(e.amountToman), 0n),
    ).toBe(oracleTotal);
    expect(result.days.reduce((sum, d) => sum + BigInt(d.netToman!), 0n)).toBe(
      oracleTotal,
    );
  });

  it('reconciles Create + two renewals + full latest-purchase deletion credit', () => {
    const events: ReplaySourceEvent[] = [
      base,
      {
        ...base,
        id: '2',
        action: 'data_usage_reset',
        sourceTimestamp: '2026-11-20T12:01:00Z',
      },
      {
        ...base,
        id: '3',
        action: 'user_updated',
        sourceTimestamp: '2026-11-20T12:02:00Z',
      },
      {
        ...base,
        id: '4',
        action: 'user_updated',
        sourceTimestamp: '2026-11-20T12:20:00Z',
        dataLimitBytes: (100n * GiB).toString(),
      },
      {
        ...base,
        id: '5',
        action: 'data_usage_reset',
        sourceTimestamp: '2026-11-20T12:21:00Z',
        dataLimitBytes: (100n * GiB).toString(),
      },
      {
        ...base,
        id: '6',
        action: 'user_deleted',
        sourceTimestamp: '2026-11-21T13:00:00Z',
        dataLimitBytes: (100n * GiB).toString(),
      },
    ];
    const withoutCredit = calculateReplayShadow(events, catalog, settings);
    const withCredit = calculateReplayShadow(events, catalog, {
      ...settings,
      deleteCreditEnabled: true,
    });
    expect(withoutCredit.entries.map((e) => e.kind)).toEqual([
      'CREATE',
      'RENEWAL',
      'RENEWAL',
    ]);
    expect(
      withCredit.entries.map((e) => [e.kind, e.entryType, e.amountToman]),
    ).toEqual([
      ['CREATE', 'CHARGE', '100000'],
      ['RENEWAL', 'CHARGE', '100000'],
      ['RENEWAL', 'CHARGE', '200000'],
      ['DELETE_CREDIT', 'CREDIT', '200000'],
    ]);
    expect(
      withoutCredit.entries.reduce((sum, e) => sum + BigInt(e.amountToman), 0n),
    ).toBe(400_000n);
    expect(
      withCredit.entries.reduce(
        (sum, e) =>
          sum + (e.entryType === 'CREDIT' ? -1n : 1n) * BigInt(e.amountToman),
        0n,
      ),
    ).toBe(200_000n);
    expect(withCredit.entries.at(-1)?.referenceOperationKey).toBe(
      withCredit.entries.at(-2)?.operationKey,
    );
  });

  it('never turns a blocked admin-day into a booked zero or a guessed price', () => {
    const events: ReplaySourceEvent[] = [
      base,
      {
        ...base,
        id: '2',
        externalUserId: '2',
        sourceTimestamp: '2026-11-20T12:01:00Z',
        durationSeconds: null,
      },
    ];
    const result = calculateReplayShadow(events, catalog, settings);
    expect(result.holds).toHaveLength(1);
    expect(result.heldCandidates).toMatchObject([
      { kind: 'CREATE', amountToman: '100000' },
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.days).toMatchObject([
      {
        status: 'PENDING_REVIEW',
        totalChargeToman: null,
        totalCreditToman: null,
        netToman: null,
        entryCount: 0,
      },
    ]);
  });
});

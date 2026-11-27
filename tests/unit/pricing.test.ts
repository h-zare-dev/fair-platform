import { describe, expect, it } from 'vitest';
import {
  price,
  PricingError,
  GIB_BYTES,
  MAX_BIGINT,
  type PricingRule,
} from '@fair-platform/pricing';

const from = '2026-10-01T00:00:00.000000Z';
const until = '2026-11-01T00:00:00.000000Z';
const base: PricingRule = {
  versionId: '1',
  source: 'DEFAULT_PLAN',
  sourceInstanceId: 'synthetic',
  billingAdminId: null,
  mode: 'PER_GIB',
  rateTomanPerGiB: '5',
  fixedPackages: {},
  effectiveFrom: from,
  effectiveUntil: until,
};
const req = {
  sourceInstanceId: 'synthetic',
  billingAdminId: '42',
  occurredAt: from,
  billableBytes: String(GIB_BYTES / 2n),
  purpose: 'FULL_PACKAGE' as const,
};

describe('FP-004 exact pricing: approved CEIL policy', () => {
  it('prices fractional GiB without floating point or premature rounding', () => {
    expect(price(req, [base]).amountToman).toBe('3');
    expect(
      price({ ...req, billableBytes: String(GIB_BYTES) }, [base]).amountToman,
    ).toBe('5');
    expect(price({ ...req, billableBytes: '1' }, [base]).amountToman).toBe('1');
    expect(
      price({ ...req, billableBytes: String(GIB_BYTES * 3n) }, [base])
        .amountToman,
    ).toBe('15');
    expect(
      price({ ...req, billableBytes: String(GIB_BYTES - 1n) }, [base])
        .amountToman,
    ).toBe('5');
  });
  it('fixed exact package; mixed exact first and then per-GiB in same rule', () => {
    const fixed: PricingRule = {
      ...base,
      mode: 'FIXED',
      rateTomanPerGiB: null,
      fixedPackages: { [req.billableBytes]: '17' },
    };
    expect(price(req, [fixed]).amountToman).toBe('17');
    expect(() => price({ ...req, billableBytes: '1' }, [fixed])).toThrow(
      'PRICING_MISSING',
    );
    const mixed: PricingRule = {
      ...fixed,
      mode: 'MIXED',
      rateTomanPerGiB: '5',
    };
    expect(price(req, [mixed]).amountToman).toBe('17');
    expect(price({ ...req, billableBytes: '1' }, [mixed]).amountToman).toBe(
      '1',
    );
  });
  it('admin override > assigned > default, never lower-tier price fallback', () => {
    const assigned: PricingRule = {
      ...base,
      versionId: '2',
      source: 'ASSIGNED_PLAN',
      billingAdminId: '42',
      rateTomanPerGiB: '7',
    };
    const override: PricingRule = {
      ...assigned,
      versionId: '3',
      source: 'ADMIN_OVERRIDE',
      mode: 'FIXED',
      rateTomanPerGiB: null,
      fixedPackages: {},
    };
    expect(price(req, [base, assigned]).amountToman).toBe('4');
    expect(() => price(req, [base, assigned, override])).toThrow(
      'PRICING_MISSING',
    );
    expect(
      price(req, [
        base,
        assigned,
        { ...override, fixedPackages: { [req.billableBytes]: '30' } },
      ]).amountToman,
    ).toBe('30');
  });
  it('half-open effective dates and ambiguous versions fail closed', () => {
    expect(price(req, [base]).ruleVersionId).toBe('1');
    expect(() => price({ ...req, occurredAt: until }, [base])).toThrow(
      'PRICING_MISSING',
    );
    expect(
      price({ ...req, occurredAt: until }, [
        { ...base, versionId: '2', effectiveFrom: until, effectiveUntil: null },
      ]).ruleVersionId,
    ).toBe('2');
    expect(() => price(req, [base, { ...base, versionId: '2' }])).toThrow(
      'PRICING_CONFIG_CONFLICT',
    );
  });
  it('invalid numeric inputs, ambiguous identity, source isolation and unlimited fail closed', () => {
    for (const invalid of [1, 1.5, '-1', '01', '0', String(MAX_BIGINT + 1n)])
      expect(() =>
        price({ ...req, billableBytes: invalid as string }, [base]),
      ).toThrow('INVALID_PRICING_INPUT');
    expect(() => price({ ...req, unlimited: true }, [base])).toThrow(
      'UNEXPECTED_UNLIMITED',
    );
    expect(() =>
      price({ ...req, occurredAt: '2026-02-30T00:00:00Z' }, [base]),
    ).toThrow('INVALID_PRICING_INPUT');
    expect(() =>
      price({ ...req, sourceInstanceId: 'another-source' }, [base]),
    ).toThrow('PRICING_MISSING');
    expect(() =>
      price({ ...req, billingAdminId: '43' }, [
        { ...base, source: 'ADMIN_OVERRIDE', billingAdminId: '42' },
      ]),
    ).toThrow('PRICING_MISSING');
  });
  it('never overflows PostgreSQL BIGINT or leaks input details in errors', () => {
    expect(() =>
      price({ ...req, billableBytes: String(MAX_BIGINT) }, [
        { ...base, rateTomanPerGiB: String(MAX_BIGINT) },
      ]),
    ).toThrow('PRICING_OVERFLOW');
    expect(new PricingError('PRICING_MISSING').message).toBe('PRICING_MISSING');
  });
});

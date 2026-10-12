import { describe, expect, it } from 'vitest';
import {
  AccountingError,
  exceptionMessages,
  validateAccountingException,
  validateShadowCharge,
  type ShadowChargeInput,
} from '@fair-platform/accounting';
const charge: ShadowChargeInput = {
  sourceInstanceId: 'synthetic',
  operationKey: 'operation-1',
  billingAdminId: '7',
  externalUserId: '8',
  amountToman: '1',
  occurredAt: '2026-10-01T00:00:00Z',
  reasonCode: 'SYNTHETIC_CHARGE',
  eventIds: ['1'],
};
describe('pure accounting invariants', () => {
  it.each([
    '1',
    '9007199254740993',
    '9223372036854775807',
    1n,
    9223372036854775807n,
  ])('preserves positive integer Toman %s', (amountToman) => {
    expect(validateShadowCharge({ ...charge, amountToman }).amountToman).toBe(
      String(amountToman),
    );
  });
  it.each([
    0,
    1,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    NaN,
    Infinity,
    null,
    undefined,
    '0',
    0n,
    '-1',
    -1n,
    '1.5',
    '01',
    '+1',
    ' 1',
    '1 ',
    '1e3',
    '',
    '9223372036854775808',
    '1'.repeat(100),
  ])('rejects invalid money %s', (amountToman) => {
    expect(() =>
      validateShadowCharge({ ...charge, amountToman } as ShadowChargeInput),
    ).toThrow('INVALID_ACCOUNTING_INPUT');
  });
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T00:00:60Z',
    '2026-10-01',
    '2026-10-01T00:00:00.1234567Z',
    'invalid',
    '0000-01-01T00:00:00Z',
    null,
  ])('rejects invalid timestamp %s', (occurredAt) => {
    expect(() =>
      validateShadowCharge({ ...charge, occurredAt } as ShadowChargeInput),
    ).toThrow('INVALID_ACCOUNTING_INPUT');
  });
  it('preserves microseconds, canonicalizes the event set and freezes results', () => {
    const value = validateShadowCharge({
      ...charge,
      occurredAt: '2026-10-01T00:00:00.123456Z',
      eventIds: ['10', 2n, '10'],
    });
    expect(value.occurredAt).toBe('2026-10-01T00:00:00.123456Z');
    expect(value.eventIds).toEqual(['2', '10']);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.eventIds)).toBe(true);
  });
  it.each([
    { sourceInstanceId: '' },
    { sourceInstanceId: 'a'.repeat(101) },
    { sourceInstanceId: 'a\u0000' },
    { operationKey: '' },
    { operationKey: 'a'.repeat(129) },
    { operationKey: 'a b' },
    { billingAdminId: '-1' },
    { billingAdminId: '01' },
    { externalUserId: null },
    { externalUserId: '9223372036854775808' },
    { eventIds: [] },
    { eventIds: ['0'] },
    { eventIds: [1] },
    { eventIds: null },
    { reasonCode: '' },
    { reasonCode: 'a'.repeat(65) },
    { reasonCode: 'a\u0000' },
  ])('rejects invalid identifiers and references %j', (changes) => {
    expect(() =>
      validateShadowCharge({ ...charge, ...changes } as ShadowChargeInput),
    ).toThrow('INVALID_ACCOUNTING_INPUT');
  });
  it('accepts canonical zero external identities inherited from FP-001', () => {
    expect(
      validateShadowCharge({
        ...charge,
        externalUserId: 0n,
        billingAdminId: '0',
      }),
    ).toMatchObject({ externalUserId: '0', billingAdminId: '0' });
  });
  it.each(Object.keys(exceptionMessages))(
    'only emits a fixed message for %s',
    (exceptionCode) => {
      const value = validateAccountingException({
        sourceInstanceId: 'synthetic',
        exceptionKey: 'exception',
        exceptionCode,
      } as Parameters<typeof validateAccountingException>[0]);
      expect(value.message).toBe(exceptionMessages[value.exceptionCode]);
      expect(value.status).toBe('OPEN');
      expect(value.eventId).toBeNull();
    },
  );
  it.each(['UNKNOWN', 'toString', '__proto__', '', null])(
    'rejects unapproved exception code %s',
    (exceptionCode) => {
      expect(() =>
        validateAccountingException({
          sourceInstanceId: 'synthetic',
          exceptionKey: 'exception',
          exceptionCode,
        } as Parameters<typeof validateAccountingException>[0]),
      ).toThrow('INVALID_ACCOUNTING_INPUT');
    },
  );
  it('errors never include caller values', () => {
    const error = new AccountingError('FINANCIAL_IDEMPOTENCY_CONFLICT');
    expect(error.message).toBe(error.code);
    expect(error.cause).toBeUndefined();
  });
});

it('rejects trailing newlines and sparse event arrays without coercion', () => {
  for (const changes of [
    { amountToman: '1\n' },
    { sourceInstanceId: 'synthetic\n' },
    { operationKey: 'operation\n' },
    { reasonCode: 'REASON\n' },
    { occurredAt: '2026-10-01T00:00:00Z\n' },
    { eventIds: new Array<unknown>(1) },
  ]) {
    expect(() =>
      validateShadowCharge({ ...charge, ...changes } as ShadowChargeInput),
    ).toThrow('INVALID_ACCOUNTING_INPUT');
  }
  expect(() =>
    validateAccountingException({
      sourceInstanceId: 'synthetic',
      exceptionKey: 'exception',
      exceptionCode: ['PRICING_MISSING'],
    } as unknown as Parameters<typeof validateAccountingException>[0]),
  ).toThrow('INVALID_ACCOUNTING_INPUT');
});

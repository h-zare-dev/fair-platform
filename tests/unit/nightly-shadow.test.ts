import { describe, expect, it, vi } from 'vitest';
import {
  classifyCreate,
  NightlyShadow,
} from '../../apps/api/dist/owner/infrastructure/nightly-shadow.js';
import { PasarguardSecretAuthenticator } from '../../apps/api/dist/owner/infrastructure/webhook-secret.js';

const fixed = {
  id: '10',
  target_kind: 'GROUP' as const,
  package_id: '5',
  package_bytes: '53687091200',
  duration_days: 30,
  amount_toman: '250000',
  rate_toman_per_gib: null,
};
const perGiB = {
  ...fixed,
  id: '11',
  package_id: null,
  package_bytes: null,
  duration_days: null,
  amount_toman: null,
  rate_toman_per_gib: '1001',
};
describe('nightly-only SHADOW create classification', () => {
  it('matches exact bytes and integer days, with no default pricing', () => {
    const result = classifyCreate(
      '53687091200',
      '2592000',
      [fixed],
      false,
      false,
    );
    expect(result).toMatchObject({
      amount: '250000',
      reason: null,
      packageId: '5',
    });
    expect(
      classifyCreate('53687091200', '2591999', [fixed], false, false).reason,
    ).toBe('MISSING_DURATION');
    expect(
      classifyCreate('53687091200', '5184000', [fixed], false, false).reason,
    ).toBe('PRICING_MISSING');
  });
  it('computes half a GiB from integer bytes with final Toman CEIL', () => {
    expect(
      classifyCreate('536870912', null, [perGiB], false, false).amount,
    ).toBe('501');
    expect(classifyCreate('0', null, [perGiB], false, false).reason).toBe(
      'UNEXPECTED_UNLIMITED',
    );
  });
  it('blocks corrections, unverified next plans and conflicting pricing', () => {
    expect(
      classifyCreate('53687091200', '2592000', [fixed], true, false).reason,
    ).toBe('AMBIGUOUS_CORRECTION');
    expect(
      classifyCreate('53687091200', '2592000', [fixed], false, true).reason,
    ).toBe('AMBIGUOUS_CORRELATION');
    expect(
      classifyCreate(
        '53687091200',
        '2592000',
        [fixed, { ...fixed, id: '12' }],
        false,
        false,
      ).reason,
    ).toBe('PRICING_CONFIG_CONFLICT');
  });
  it('prefers a direct admin exact-match exception over the group', () => {
    const direct = {
      ...fixed,
      id: '20',
      target_kind: 'ADMIN' as const,
      amount_toman: '500000',
    };
    expect(
      classifyCreate('53687091200', '2592000', [fixed, direct], false, false),
    ).toMatchObject({ amount: '500000', assignmentId: '20' });
  });
  it('freezes the package rule exactly at midnight, not any overlap that day', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const shadow = new NightlyShadow({} as never, 'Asia/Tehran');
    await (
      shadow as unknown as { rules: (...args: unknown[]) => Promise<unknown> }
    ).rules(
      { query },
      'primary',
      '9001',
      '42',
      '2026-11-20T20:30:00Z',
      '2026-11-21T20:30:00Z',
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('a.created_at < $4');
    expect(sql).toContain('a.effective_from < $4');
    expect(sql).toContain('a.effective_until >= $4');
    expect(sql).not.toContain('a.effective_until > $3');
  });
  it('never classifies pre-existing synthetic dashboard events as live Shadow', async () => {
    const query = vi.fn((sql: string, params?: unknown[]) => {
      void params;
      return Promise.resolve(
        sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : [],
      );
    });
    const fake = {
      transaction: async (
        _isolation: string,
        work: (tx: unknown) => Promise<boolean>,
      ) => work({ query }),
    };
    const runner = new NightlyShadow(fake as never, 'Asia/Tehran');
    await (
      runner as unknown as { closeNext: (now: Date) => Promise<boolean> }
    ).closeNext(new Date());
    const lookup = query.mock.calls.find(([sql]) =>
      sql.includes('FROM pasarguard_events e LEFT JOIN'),
    );
    expect(lookup?.[0]).toContain('e.source_instance_id=$2');
    expect(lookup?.[1]?.[1]).toBe('primary');
  });
});
describe('authenticated second destination', () => {
  it('accepts only the independent exact secret without logging it', async () => {
    const secret = 'synthetic-test-secret-not-a-live-value-12345';
    const auth = new PasarguardSecretAuthenticator(secret);
    expect(
      await auth.authenticate({ headers: { 'x-webhook-secret': secret } }),
    ).toBe(true);
    expect(
      await auth.authenticate({
        headers: { 'x-webhook-secret': secret + 'x' },
      }),
    ).toBe(false);
    expect(
      await auth.authenticate({
        headers: { 'x-webhook-secret': [secret, secret] },
      }),
    ).toBe(false);
    expect(await auth.authenticate({ headers: {} })).toBe(false);
    expect(() => new PasarguardSecretAuthenticator('short')).toThrow(
      'INVALID_WEBHOOK_SECRET',
    );
  });
});

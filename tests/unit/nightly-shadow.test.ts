import { describe, expect, it, vi } from 'vitest';
import {
  classifyCreate,
  classifyRenewals,
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
  it('reconciles a 30-day synthetic Create-only price matrix using integer math', () => {
    // Arithmetic stress/regression only: not an imported historical-data audit,
    // nightly PostgreSQL close, Update, Reset or financial ledger acceptance.
    let quoted = 0n;
    let expected = 0n;
    const gib = 1073741824n;
    for (let day = 0; day < 30; day++) {
      for (let admin = 0; admin < 153; admin++) {
        const bytes = (BigInt((day + admin) % 100) * gib + gib / 4n).toString();
        const result = classifyCreate(bytes, null, [perGiB], false, false);
        expect(result.reason).toBeNull();
        quoted += BigInt(result.amount!);
        // 0.25 GiB × 1001 Toman = 250.25, rounded only once to 251.
        expected += BigInt((day + admin) % 100) * 1001n + 251n;
      }
    }
    expect(quoted).toBe(expected);
    expect(quoted).toBeGreaterThan(0n);
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
    ).rules({ query }, 'primary', '9001', '42', '2026-11-21T20:30:00Z');
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('a.created_at < $3');
    expect(sql).toContain('a.effective_from < $3');
    expect(sql).toContain('a.effective_until >= $3');
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

describe('nightly renewal attribution', () => {
  const change = (id: string, action: string) => ({
    id,
    action,
    source_instance_id: 'primary',
    billing_admin_id: '5',
    external_user_id: '9',
    username: 'fixture',
    source_enqueued_at: new Date(Number(id) * 1000),
    data_limit_bytes: '53687091200',
    on_hold_expire_duration_seconds: '2592000',
    event_status: 'READY_FOR_ACCOUNTING',
  });
  it('prices a same-second renewal once at the assigned GiB rate even when durations differ', () => {
    const update = change('1', 'user_updated');
    const reset = {
      ...change('2', 'data_usage_reset'),
      source_enqueued_at: update.source_enqueued_at,
      on_hold_expire_duration_seconds: '5184000',
    };
    const pair = [update, reset];
    const result = classifyRenewals(pair, [
      { ...perGiB, rate_toman_per_gib: '2000' },
    ]);
    expect(result.get('1')).toMatchObject({
      amount: '100000',
      durationDays: null,
    });
    expect(result.get('2')?.reason).toBe('RENEWAL_EVIDENCE');
    expect(classifyRenewals(pair, []).get('1')?.reason).toBe('PRICING_MISSING');
  });
  it('counts an update/reset once and holds repeated clicks for the Owner', () => {
    const pair = [change('1', 'user_updated'), change('2', 'data_usage_reset')];
    const classified = classifyRenewals(pair, [fixed]);
    expect(classified.get('1')?.amount).toBe(fixed.amount_toman);
    expect(classified.get('2')?.reason).toBe('RENEWAL_EVIDENCE');
    const repeated = classifyRenewals(
      [...pair, change('3', 'user_updated')],
      [fixed],
    );
    expect(
      [...repeated.values()].every(
        (row) => row.reason === 'AMBIGUOUS_CORRELATION',
      ),
    ).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresPricingStore } from '../../apps/api/dist/owner/infrastructure/pricing-store.js';
import { PostgresOwnerAuth } from '../../apps/api/dist/owner/infrastructure/auth-store.js';
import { PostgresOwnerOperations } from '../../apps/api/dist/owner/infrastructure/operations.js';
import { passwords } from '../../apps/api/dist/owner/infrastructure/password.js';
import { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import { createOwnerApi } from '../../apps/api/dist/owner/app.js';

const origin = 'https://panel.fairisfair.ir';
const csrf = { origin, 'content-type': 'application/json', 'x-fair-csrf': '1' };
const from = '2026-12-01T00:00:00.000000Z';
const until = '2027-01-01T00:00:00.000000Z';
const base = {
  sourceInstanceId: 'synthetic',
  effectiveFrom: from,
  effectiveUntil: until,
};
const request = {
  sourceInstanceId: 'synthetic',
  billingAdminId: '9001',
  occurredAt: '2026-12-15T00:00:00Z',
  billableBytes: '536870912',
  purpose: 'POSITIVE_DELTA' as const,
};
let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
let store: PostgresPricingStore;
let api: Awaited<ReturnType<typeof createOwnerApi>>;
let owner: PostgresOwnerAuth;
const password = 'synthetic-pricing-owner-test-password';

beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  store = new PostgresPricingStore(db);
  owner = new PostgresOwnerAuth(db);
  const auth = new OwnerAuth(
    owner,
    passwords,
    await passwords.hash('synthetic-dummy'),
  );
  api = await createOwnerApi(
    auth,
    new PostgresOwnerOperations(db),
    origin,
    store,
  );
}, 120000);
afterAll(async () => {
  if (api) await api.close();
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});
beforeEach(async () => {
  await db.query(`TRUNCATE fair_pricing_audit,fair_pricing_assignments,fair_pricing_fixed_packages,
    fair_pricing_rule_versions,fair_pricing_plans RESTART IDENTITY CASCADE`);
  await db.query(
    'TRUNCATE fair_owner_sessions,fair_owner,fair_owner_login_budget,fair_owner_audit RESTART IDENTITY CASCADE',
  );
});

const rule = (planId: string, rate = '5') => ({
  ...base,
  planId,
  mode: 'PER_GIB' as const,
  rateTomanPerGiB: rate,
  fixedPackages: {},
});
async function seeded() {
  const plan = await store.createPlan({
    sourceInstanceId: 'synthetic',
    name: 'Standard',
  });
  const version = await store.createVersion(rule(plan.id));
  await store.assign({ ...base, planId: plan.id, billingAdminId: null });
  return { plan, version };
}

describe('FP-004 PostgreSQL and Owner protections', () => {
  it('applies all forward migrations, retains exact integer price and historical version', async () => {
    const { version } = await seeded();
    const q = await store.quote(request);
    expect(q).toMatchObject({
      amountToman: '3',
      ruleVersionId: version.id,
      source: 'DEFAULT_PLAN',
      billableBytes: '536870912',
    });
    const second = await store.createPlan({
      sourceInstanceId: 'synthetic',
      name: 'Later',
    });
    await store.createVersion({
      ...rule(second.id, '200'),
      effectiveFrom: until,
      effectiveUntil: null,
    });
    await store.assign({
      ...base,
      planId: second.id,
      billingAdminId: null,
      effectiveFrom: until,
      effectiveUntil: null,
    });
    expect((await store.quote(request)).ruleVersionId).toBe(version.id);
    expect(
      (await store.quote({ ...request, occurredAt: until })).amountToman,
    ).toBe('100');
    expect(
      await db.query('SELECT COUNT(*)::int AS count FROM fair_pricing_audit'),
    ).toEqual([{ count: 6 }]);
  });

  it('rejects concurrent conflicting effective intervals, cross-source FKs, immutable edits and missing fixed', async () => {
    const { plan, version } = await seeded();
    const writes = await Promise.allSettled([
      store.createVersion(rule(plan.id, '8')),
      store.createVersion(rule(plan.id, '9')),
    ]);
    expect(writes.every((v) => v.status === 'rejected')).toBe(true);
    await expect(
      db.query('UPDATE fair_pricing_rule_versions SET mode=$1 WHERE id=$2', [
        'MIXED',
        version.id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM fair_pricing_plans WHERE id=$1', [plan.id]),
    ).rejects.toThrow();
    const other = await store.createPlan({
      sourceInstanceId: 'different',
      name: 'Other',
    });
    await expect(
      store.assign({ ...base, planId: other.id, billingAdminId: '9001' }),
    ).rejects.toThrow();
    await expect(
      store.quote({ ...request, sourceInstanceId: 'different' }),
    ).rejects.toThrow('PRICING_MISSING');
    await expect(
      store.createVersion({
        ...base,
        planId: plan.id,
        mode: 'FIXED',
        rateTomanPerGiB: null,
        fixedPackages: { '536870912': '17' },
      }),
    ).rejects.toThrow();
  });

  it('honors admin override > assigned > default and prevents falling through missing exact fixed price', async () => {
    const { plan } = await seeded();
    const special = await store.createPlan({
      sourceInstanceId: 'synthetic',
      name: 'Special',
    });
    await store.createVersion(rule(special.id, '7'));
    await store.assign({ ...base, planId: special.id, billingAdminId: '9001' });
    expect((await store.quote(request)).amountToman).toBe('4');
    await store.createVersion({
      ...base,
      billingAdminId: '9001',
      mode: 'FIXED',
      rateTomanPerGiB: null,
      fixedPackages: { '1073741824': '20' },
    });
    await expect(store.quote(request)).rejects.toThrow('PRICING_MISSING');
    expect(
      (await store.quote({ ...request, billableBytes: '1073741824' }))
        .amountToman,
    ).toBe('20');
    expect(
      await db.query('SELECT id FROM fair_pricing_plans WHERE id=$1', [
        plan.id,
      ]),
    ).toHaveLength(1);
  });

  it('rolls back invalid catalogs; enforces overlap windows in database under concurrency', async () => {
    const plan = await store.createPlan({
      sourceInstanceId: 'synthetic',
      name: 'Catalog',
    });
    await expect(
      store.createVersion({
        ...base,
        planId: plan.id,
        mode: 'FIXED',
        rateTomanPerGiB: null,
        fixedPackages: {
          '536870912': '15',
          '1073741824': '9223372036854775808',
        },
      }),
    ).rejects.toThrow();
    expect(
      await db.query('SELECT id FROM fair_pricing_rule_versions'),
    ).toHaveLength(0);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.assign({ ...base, planId: plan.id, billingAdminId: '45' }),
      ),
    );
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  });

  it('allows only authenticated Owner+same-origin CSRF writes and never touches ledger', async () => {
    const body = { sourceInstanceId: 'synthetic', name: 'Owner-managed' };
    const url = '/api/v1/owner/pricing/plans';
    expect(
      (await api.inject({ method: 'POST', url, headers: csrf, payload: body }))
        .statusCode,
    ).toBe(401);
    await owner.bootstrap(await passwords.hash(password));
    const signed = await api.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      headers: csrf,
      payload: { password },
    });
    const cookie = String(signed.headers['set-cookie']).split(';')[0]!;
    for (const h of [
      { cookie },
      { cookie, ...csrf, origin: 'https://wrong.example' },
      { cookie, ...csrf, 'x-fair-csrf': '0' },
    ])
      expect(
        (await api.inject({ method: 'POST', url, headers: h, payload: body }))
          .statusCode,
      ).toBe(403);
    const saved = await api.inject({
      method: 'POST',
      url,
      headers: { ...csrf, cookie },
      payload: body,
    });
    expect(saved.statusCode).toBe(201);
    expect(
      (
        await api.inject({
          method: 'POST',
          url,
          headers: { ...csrf, cookie },
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api.inject({
          url: '/api/v1/owner/pricing/config?source=synthetic',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api.inject({
          url: '/api/v1/owner/pricing/config?source=synthetic',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await db.query<{ ledger: string | null }[]>(
          "SELECT to_regclass('accounting_transactions')::text AS ledger",
        )
      )[0]?.ledger,
    ).toBeNull();
  });
});

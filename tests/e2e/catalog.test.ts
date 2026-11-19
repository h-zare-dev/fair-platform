import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresCatalogStore } from '../../apps/api/dist/owner/infrastructure/catalog-store.js';
import { PostgresOwnerAuth } from '../../apps/api/dist/owner/infrastructure/auth-store.js';
import { PostgresOwnerOperations } from '../../apps/api/dist/owner/infrastructure/operations.js';
import { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import { passwords } from '../../apps/api/dist/owner/infrastructure/password.js';
import { createOwnerApi } from '../../apps/api/dist/owner/app.js';
import { PostgresPricingStore } from '../../apps/api/dist/owner/infrastructure/pricing-store.js';

const origin = 'https://panel.fairisfair.ir';
const csrf = { origin, 'content-type': 'application/json', 'x-fair-csrf': '1' };
const s = 'synthetic';
const pkgInput = {
  sourceInstanceId: s,
  name: '50 GiB / 30 days',
  packageBytes: '53687091200',
  durationDays: 30,
  amountToman: '150000',
};
const input = {
  sourceInstanceId: s,
  targetKind: 'GROUP' as const,
  targetId: '1',
  startDate: '1405-09-10',
  endDate: '1405-09-30',
};
let postgres: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
let catalog: PostgresCatalogStore;
let owner: PostgresOwnerAuth;
let api: Awaited<ReturnType<typeof createOwnerApi>>;

beforeAll(async () => {
  postgres = await startPostgres();
  db = createOwnerDataSource(postgres.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  catalog = new PostgresCatalogStore(db, 'Asia/Tehran');
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
    new PostgresPricingStore(db),
    catalog,
  );
}, 120000);
afterAll(async () => {
  if (api) await api.close();
  if (db?.isInitialized) await db.destroy();
  if (postgres) await postgres.stop();
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE fair_tariff_assignments,fair_admin_group_membership_audit,fair_admin_group_memberships,fair_atomic_packages,fair_admin_groups RESTART IDENTITY CASCADE',
  );
  await db.query(
    'TRUNCATE fair_owner_sessions,fair_owner,fair_owner_login_budget,fair_owner_audit RESTART IDENTITY CASCADE',
  );
});

describe('FP-004 atomic catalog: forward migration, immutable history and conflicts', () => {
  it('tracks single membership and immutable transitions without any membership date fields', async () => {
    const a = await catalog.createGroup({ sourceInstanceId: s, name: 'A' });
    const b = await catalog.createGroup({ sourceInstanceId: s, name: 'B' });
    expect(
      await catalog.changeMembership({
        sourceInstanceId: s,
        billingAdminId: '9001',
        groupId: a.id,
      }),
    ).toMatchObject({ action: 'ASSIGN' });
    expect(
      await catalog.changeMembership({
        sourceInstanceId: s,
        billingAdminId: '9001',
        groupId: b.id,
      }),
    ).toMatchObject({ action: 'TRANSFER', oldGroupId: a.id });
    const all = await catalog.list(s);
    expect(all.memberships).toEqual([
      { billingAdminId: '9001', groupId: b.id },
    ]);
    expect(all.membershipHistory.map((h) => h.action)).toEqual([
      'TRANSFER',
      'ASSIGN',
    ]);
    await expect(
      db.query('UPDATE fair_admin_group_membership_audit SET action=$1', [
        'REMOVE',
      ]),
    ).rejects.toThrow();
    await catalog.changeMembership({
      sourceInstanceId: s,
      billingAdminId: '9001',
      groupId: null,
    });
    expect((await catalog.list(s)).memberships).toHaveLength(0);
  });

  it('locks package financial fields permanently after assignment and supports copy for a new price', async () => {
    await catalog.createGroup({ sourceInstanceId: s, name: 'A' });
    const pkg = await catalog.createPackage(pkgInput);
    await catalog.editPackage({
      ...pkgInput,
      packageId: pkg.id,
      amountToman: '155000',
    });
    const result = await catalog.assign({ ...input, packageId: pkg.id });
    expect(result).toMatchObject({
      startDate: '1405-09-10',
      endDate: '1405-09-30',
      fromUtc: '2026-11-30T20:30:00.000Z',
    });
    await expect(
      catalog.editPackage({ ...pkgInput, packageId: pkg.id }),
    ).rejects.toThrow('PACKAGE_ALREADY_ASSIGNED');
    await expect(
      db.query('UPDATE fair_atomic_packages SET amount_toman=1 WHERE id=$1', [
        pkg.id,
      ]),
    ).rejects.toThrow('PACKAGE_ALREADY_ASSIGNED');
    const duplicate = await catalog.copyPackage({
      sourceInstanceId: s,
      packageId: pkg.id,
      name: '50 GiB / 30 / newer',
      amountToman: '200000',
    });
    expect(
      (await catalog.list(s)).packages.find((p) => p.id === duplicate.id),
    ).toMatchObject({ amountToman: '200000', everAssigned: false });
    expect(
      await db.query(
        'SELECT count(*)::int AS count FROM accounting_transactions',
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('permits different duration shapes, rejects same-shape and PER_GIB overlaps, and protects starts', async () => {
    await catalog.createGroup({ sourceInstanceId: s, name: 'A' });
    const first = await catalog.createPackage(pkgInput);
    const sameShape = await catalog.createPackage({
      ...pkgInput,
      name: 'same-size-price-diff',
      amountToman: '200000',
    });
    const differentDuration = await catalog.createPackage({
      ...pkgInput,
      name: '60 days',
      durationDays: 60,
    });
    const a = await catalog.assign({ ...input, packageId: first.id });
    await catalog.assign({ ...input, packageId: differentDuration.id });
    await expect(
      catalog.assign({ ...input, packageId: sameShape.id }),
    ).rejects.toThrow('TARIFF_ASSIGNMENT_CONFLICT');
    await expect(
      catalog.assign({ ...input, rateTomanPerGiB: '1000' }),
    ).rejects.toThrow('TARIFF_ASSIGNMENT_CONFLICT');
    await expect(
      db.query(
        "UPDATE fair_tariff_assignments SET effective_from=effective_from + interval '1 day' WHERE id=$1",
        [a.id],
      ),
    ).rejects.toThrow('ASSIGNMENT_START_IMMUTABLE');
    await expect(
      catalog.changeEnd({
        sourceInstanceId: s,
        assignmentId: a.id,
        endDate: '1405-09-05',
      }),
    ).rejects.toThrow('INVALID_DATE_WINDOW');
    await catalog.changeEnd({
      sourceInstanceId: s,
      assignmentId: a.id,
      endDate: '1405-09-29',
    });
    const next = await catalog.copyPackage({
      sourceInstanceId: s,
      packageId: first.id,
      name: 'next',
      amountToman: '170000',
    });
    await expect(
      catalog.assign({
        ...input,
        packageId: next.id,
        startDate: '1405-09-29',
        endDate: null,
      }),
    ).rejects.toThrow('TARIFF_ASSIGNMENT_CONFLICT');
    const future = await catalog.assign({
      ...input,
      packageId: next.id,
      startDate: '1405-09-30',
      endDate: null,
    });
    expect(future.startDate).toBe('1405-09-30');
  });

  it('enforces Owner session+CSRF and rejects unauthenticated catalogue writes', async () => {
    const url = '/api/v1/owner/catalog/groups';
    const payload = { sourceInstanceId: s, name: 'Only Owner' };
    expect(
      (await api.inject({ method: 'POST', url, payload, headers: csrf }))
        .statusCode,
    ).toBe(401);
    await owner.bootstrap(await passwords.hash('synthetic-catalog-password'));
    const login = await api.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/login',
      headers: csrf,
      payload: { password: 'synthetic-catalog-password' },
    });
    expect(login.statusCode).toBe(201);
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
    expect(
      (
        await api.inject({
          method: 'POST',
          url,
          headers: { ...csrf, origin: 'https://evil.invalid', cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api.inject({
          method: 'POST',
          url,
          headers: { ...csrf, cookie },
          payload,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/v1/owner/catalog/config?source=synthetic',
          headers: { cookie },
        })
      ).json(),
    ).toMatchObject({
      groups: [{ name: 'Only Owner' }],
      timeZone: 'Asia/Tehran',
    });
  });

  it('serializes two competing assignments to one target without double-winning', async () => {
    await catalog.createGroup({ sourceInstanceId: s, name: 'Concurrent' });
    const a = await catalog.createPackage(pkgInput);
    const b = await catalog.createPackage({
      ...pkgInput,
      name: 'Higher price',
      amountToman: '220000',
    });
    const attempted = await Promise.allSettled([
      catalog.assign({ ...input, packageId: a.id }),
      catalog.assign({ ...input, packageId: b.id }),
    ]);
    expect(attempted.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await catalog.list(s)).assignments).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import {
  STATIC_CATALOG_SHAPES,
  staticCatalogWithVerifiedPrices,
} from '../../apps/api/dist/owner/application/static-catalog-bootstrap.js';

const prices = STATIC_CATALOG_SHAPES.map((shape, index) => ({
  name: shape.name,
  amountToman: String(100000 + index * 1000),
}));

describe('Owner-approved 25 fixed shapes and exact historical price inputs', () => {
  it('contains exactly 6+9+9+1 canonical shapes and never pre-fills financial amounts', () => {
    expect(STATIC_CATALOG_SHAPES).toHaveLength(25);
    expect(new Set(STATIC_CATALOG_SHAPES.map((v) => v.name)).size).toBe(25);
    expect(
      new Set(
        STATIC_CATALOG_SHAPES.map((v) => `${v.packageBytes}:${v.durationDays}`),
      ).size,
    ).toBe(25);
    expect(
      STATIC_CATALOG_SHAPES.filter((v) => v.durationDays === 30),
    ).toHaveLength(6);
    expect(
      STATIC_CATALOG_SHAPES.filter((v) => v.durationDays === 60),
    ).toHaveLength(9);
    expect(
      STATIC_CATALOG_SHAPES.filter((v) => v.durationDays === 90),
    ).toHaveLength(9);
    expect(STATIC_CATALOG_SHAPES.filter((v) => v.durationDays === 2)).toEqual([
      { name: 'Test 500MB', packageBytes: '536870912', durationDays: 2 },
    ]);
    expect(JSON.stringify(STATIC_CATALOG_SHAPES)).not.toContain('amountToman');
  });

  it('preserves every submitted positive integer Toman amount, including above JS precision', () => {
    const input = prices.map((row, i) =>
      i === 0 ? { ...row, amountToman: '9007199254740993' } : row,
    );
    const result = staticCatalogWithVerifiedPrices(input);
    expect(result).toHaveLength(25);
    expect(result[0]).toMatchObject({
      name: '50G 1Month',
      packageBytes: '53687091200',
      amountToman: '9007199254740993',
    });
    expect(result[24]?.amountToman).toBe(prices[24]!.amountToman);
  });

  it('rejects missing, duplicate, unknown, zero, negative, fractional or overflow prices', () => {
    const bad = [
      prices.slice(0, 24),
      [...prices.slice(0, 24), prices[0]!],
      [...prices.slice(0, 24), { name: 'unknown', amountToman: '100' }],
      prices.map((row, i) => (i === 0 ? { ...row, amountToman: '0' } : row)),
      prices.map((row, i) => (i === 0 ? { ...row, amountToman: '-1' } : row)),
      prices.map((row, i) => (i === 0 ? { ...row, amountToman: '1.5' } : row)),
      prices.map((row, i) =>
        i === 0 ? { ...row, amountToman: '9223372036854775808' } : row,
      ),
    ];
    for (const invalid of bad)
      expect(() => staticCatalogWithVerifiedPrices(invalid)).toThrow();
  });
});

describe('Owner-only, CSRF-protected all-admin bootstrap', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('reads all 153 directory admins and invokes one atomic store operation', async () => {
    const bootstrapStaticCatalog = vi.fn(
      (payload: { adminIds: string[]; prices: typeof prices }) => {
        void payload;
        return Promise.resolve({
          sourceInstanceId: 'primary',
          packageCount: 25,
          groupCount: 1,
          memberCount: 153,
          assignedPackageCount: 25,
        });
      },
    );
    const list = vi.fn(({ offset, limit }: { offset: number; limit: number }) =>
      Promise.resolve({
        status: 'available' as const,
        total: 153,
        offset,
        limit,
        admins: Array.from({ length: Math.min(50, 153 - offset) }, (_, i) => ({
          id: String(offset + i + 1),
          username: 'synthetic-admin',
        })),
      }),
    );
    app = await createOwnerApi(
      {
        authenticated: (v: string | null) =>
          Promise.resolve(v === 'synthetic-session'),
      } as never,
      { ready: () => Promise.resolve() } as never,
      'https://panel.fairisfair.ir',
      {} as never,
      { bootstrapStaticCatalog } as never,
      { list },
    );
    const url = '/api/v1/owner/catalog/bootstrap';
    const payload = { confirmation: 'CONFIRM_25_PACKAGES_153_ADMINS', prices };
    const headers = {
      origin: 'https://panel.fairisfair.ir',
      'content-type': 'application/json',
      'x-fair-csrf': '1',
      cookie: `${COOKIE}=synthetic-session`,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload,
          headers: { ...headers, cookie: '' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload,
          headers: { ...headers, 'x-fair-csrf': '' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { ...payload, prices: prices.slice(0, 24) },
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(bootstrapStaticCatalog).not.toHaveBeenCalled();
    const requirements = await app.inject({
      url: '/api/v1/owner/catalog/bootstrap/requirements',
      headers,
    });
    expect(requirements.statusCode).toBe(200);
    expect(requirements.json()).toMatchObject({
      expectedAdmins: 153,
      pricesRequired: true,
      postingScope: 'NONE',
    });
    expect(requirements.json<{ packages: unknown[] }>().packages).toHaveLength(
      25,
    );
    const response = await app.inject({
      method: 'POST',
      url,
      payload,
      headers,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      packageCount: 25,
      memberCount: 153,
    });
    expect(list.mock.calls).toHaveLength(4);
    expect(bootstrapStaticCatalog).toHaveBeenCalledTimes(1);
    const args = bootstrapStaticCatalog.mock.calls[0]![0];
    expect(args.adminIds).toHaveLength(153);
    expect(args.prices).toEqual(prices);
    expect(response.body).not.toContain('synthetic-admin');
  });

  it('fails closed when directory loses an admin without touching catalog', async () => {
    const bootstrapStaticCatalog = vi.fn(() => Promise.resolve({}));
    app = await createOwnerApi(
      { authenticated: () => Promise.resolve(true) } as never,
      { ready: () => Promise.resolve() } as never,
      'https://panel.fairisfair.ir',
      {} as never,
      { bootstrapStaticCatalog } as never,
      {
        list: ({ offset }: { offset: number }) =>
          Promise.resolve({
            status: 'available',
            total: offset === 150 ? 152 : 153,
            offset,
            limit: 50,
            admins: [],
          }),
      } as never,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/owner/catalog/bootstrap',
      headers: {
        origin: 'https://panel.fairisfair.ir',
        'content-type': 'application/json',
        'x-fair-csrf': '1',
      },
      payload: { confirmation: 'CONFIRM_25_PACKAGES_153_ADMINS', prices },
    });
    expect(response.statusCode).toBe(503);
    expect(bootstrapStaticCatalog).not.toHaveBeenCalled();
  });
});

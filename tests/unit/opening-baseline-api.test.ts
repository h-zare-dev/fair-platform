import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import type { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import type { OperationsReader } from '../../apps/api/dist/owner/application/operations.js';
import type { PostgresOpeningBaseline } from '../../apps/api/dist/owner/infrastructure/opening-baseline.js';

const origin = 'https://panel.fairisfair.ir';
const auth = {
  authenticated: (token: string | null) =>
    Promise.resolve(token === 'test-session'),
} as OwnerAuth;
const reader = { ready: () => Promise.resolve() } as OperationsReader;
const headers = {
  cookie: `${COOKIE}=test-session`,
  origin,
  'x-fair-csrf': '1',
  'content-type': 'application/json',
};

describe('Owner authenticated opening baseline controls', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('never permits an unauthenticated or non-CSRF import', async () => {
    let starts = 0;
    const baseline = {
      start: () => {
        starts++;
        return Promise.resolve({ id: '1', status: 'PENDING' });
      },
      summary: () =>
        Promise.resolve({
          mode: 'OPENING_BASELINE_SHADOW',
          postingScope: 'NONE',
          financialCutoverReady: false,
          sourceInstanceId: 'primary',
          run: null,
        }),
    } as PostgresOpeningBaseline;
    app = await createOwnerApi(
      auth,
      reader,
      origin,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      baseline,
    );
    const path = '/api/v1/owner/operations/accounting/opening-baseline';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: {
            origin,
            'x-fair-csrf': '1',
            'content-type': 'application/json',
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, 'x-fair-csrf': '0' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers,
          payload: { cutover: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(starts).toBe(0);
    expect(
      (
        await app.inject({ method: 'POST', url: path, headers, payload: {} })
      ).json(),
    ).toEqual({ id: '1', status: 'PENDING' });
    expect((await app.inject({ url: path, headers })).json()).toMatchObject({
      postingScope: 'NONE',
      financialCutoverReady: false,
    });
    expect(starts).toBe(1);
  });

  it('requires explicitly configured source and shadow', async () => {
    app = await createOwnerApi(auth, reader, origin);
    const path = '/api/v1/owner/operations/accounting/opening-baseline';
    expect((await app.inject({ url: path, headers })).statusCode).toBe(503);
    expect(
      (await app.inject({ method: 'POST', url: path, headers, payload: {} }))
        .statusCode,
    ).toBe(503);
  });

  it('requires Owner, CSRF and UUID to replace a baseline generation', async () => {
    const keys: string[] = [];
    const baseline = {
      start: (key: string) => {
        keys.push(key);
        return Promise.resolve({ id: '3', status: 'PENDING', generation: 3 });
      },
      summary: () =>
        Promise.resolve({
          mode: 'OPENING_BASELINE_SHADOW',
          postingScope: 'NONE',
          financialCutoverReady: false,
          cutoverLocked: false,
          generation: 2,
          sourceInstanceId: 'primary',
          run: null,
        }),
    } as PostgresOpeningBaseline;
    app = await createOwnerApi(
      auth,
      reader,
      origin,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      baseline,
    );
    const url = '/api/v1/owner/operations/accounting/opening-baseline/reseed';
    const payload = { requestKey: '682c929d-fcb6-4cd4-a06d-a73d5201efb2' };
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
          headers: { ...headers, 'x-fair-csrf': '0' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { requestKey: 'oops' },
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(keys).toHaveLength(0);
    expect(
      (await app.inject({ method: 'POST', url, payload, headers })).json(),
    ).toEqual({ id: '3', status: 'PENDING', generation: 3 });
    expect(keys).toEqual([payload.requestKey]);
  });
});

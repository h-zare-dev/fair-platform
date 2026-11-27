import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import type { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import type { OperationsReader } from '../../apps/api/dist/owner/application/operations.js';
import type { PostgresReplayShadowJournal } from '../../apps/api/dist/owner/infrastructure/replay-shadow-journal.js';

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

describe('Owner-only historical SHADOW journal API', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('never permits anonymous, CSRF-less or invalid requests', async () => {
    const keys: string[] = [];
    const journal = {
      start: (key: string) => {
        keys.push(key);
        return Promise.resolve({ id: '12', status: 'PENDING' });
      },
      summary: () =>
        Promise.resolve({
          mode: 'HISTORICAL_SHADOW_LEDGER',
          postingScope: 'SHADOW',
          liveBalanceMutated: false,
          configuredDeleteCreditEnabled: false,
          run: null,
        }),
    } as PostgresReplayShadowJournal;
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
      undefined,
      journal,
    );
    const url = '/api/v1/owner/operations/accounting/replay-shadow';
    const payload = { requestKey: 'da992c69-e442-4b4e-85df-ff3bdb231947' };
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
          payload: { requestKey: 'x' },
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { ...payload, live: true },
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(keys).toHaveLength(0);
    expect(
      (await app.inject({ method: 'POST', url, payload, headers })).json(),
    ).toEqual({ id: '12', status: 'PENDING' });
    expect(keys).toEqual([payload.requestKey]);
    expect((await app.inject({ url, headers })).json()).toMatchObject({
      postingScope: 'SHADOW',
      liveBalanceMutated: false,
    });
  });

  it('fails closed if the journaling component is disabled', async () => {
    app = await createOwnerApi(auth, reader, origin);
    const url = '/api/v1/owner/operations/accounting/replay-shadow';
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { requestKey: crypto.randomUUID() },
        })
      ).statusCode,
    ).toBe(503);
  });
});

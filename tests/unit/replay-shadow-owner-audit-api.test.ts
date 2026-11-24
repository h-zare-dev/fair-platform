import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import type { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import type { OperationsReader } from '../../apps/api/dist/owner/application/operations.js';
import {
  ShadowAuditIncomplete,
  type PostgresReplayShadowAudit,
} from '../../apps/api/dist/owner/infrastructure/replay-shadow-audit.js';

const auth = {
  authenticated: (token: string | null) =>
    Promise.resolve(token === 'test-session'),
} as OwnerAuth;
const reader = { ready: () => Promise.resolve() } as OperationsReader;
const route = '/api/v1/owner/operations/accounting/replay-shadow/audit';
const headers = { cookie: `${COOKIE}=test-session` };

describe('Owner-only private SHADOW audit endpoints', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('fails closed on expired sessions, invalid/extra filters and disabled audit service', async () => {
    const audit = {
      overview: () =>
        Promise.resolve({
          postingScope: 'SHADOW',
          liveBalanceMutated: false,
        }),
    } as unknown as PostgresReplayShadowAudit;
    app = await createOwnerApi(
      auth,
      reader,
      'https://panel.fairisfair.ir',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audit,
    );
    expect(
      (await app.inject({ url: `${route}/overview`, headers: {} })).statusCode,
    ).toBe(401);
    for (const suffix of [
      '?limit=1000',
      '?date=1405-09-01',
      '?from=1405-13-01',
      '?runId=1%20OR%201=1',
      '?offset=-1',
      '?period=year',
    ]) {
      expect(
        (await app.inject({ url: `${route}/overview${suffix}`, headers }))
          .statusCode,
        suffix,
      ).toBe(400);
    }
    const ok = await app.inject({ url: `${route}/overview`, headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers.vary).toBe('Cookie');
    expect(ok.json()).toMatchObject({
      postingScope: 'SHADOW',
      liveBalanceMutated: false,
    });
  });

  it('does not return names for unauthenticated reports and rejects incomplete runs', async () => {
    const audit = {
      admins: () =>
        Promise.resolve({
          rows: [{ billingAdminId: '17', adminName: 'private-archive-name' }],
        }),
      overview: () =>
        Promise.reject(
          new ShadowAuditIncomplete('SHADOW_AUDIT_RUN_NOT_COMPLETE'),
        ),
    } as unknown as PostgresReplayShadowAudit;
    app = await createOwnerApi(
      auth,
      reader,
      'https://panel.fairisfair.ir',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audit,
    );
    const denied = await app.inject({
      url: `${route}/admins`,
      headers: { cookie: '' },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain('private-archive-name');
    const permitted = await app.inject({ url: `${route}/admins`, headers });
    expect(permitted.statusCode).toBe(200);
    const payload = permitted.json<{ rows: Array<{ adminName: string }> }>();
    expect(payload.rows[0]?.adminName).toBe('private-archive-name');
    expect(
      (await app.inject({ url: `${route}/overview`, headers })).statusCode,
    ).toBe(409);
  });
});

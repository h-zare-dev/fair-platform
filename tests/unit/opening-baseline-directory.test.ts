import { describe, expect, it } from 'vitest';
import {
  PasarguardOpeningBaselineDirectory,
  OpeningBaselineUnavailable,
} from '../../apps/api/dist/owner/infrastructure/opening-baseline-directory.js';

const secret = 'synthetic-key-123';
const user = (id: number) => ({
  id,
  username: 'synthetic_user',
  status: 'active',
  admin: { id: 17, username: 'hidden' },
  data_limit: 53687091200,
  used_traffic: 1000,
  expire: '2026-12-31T00:00:00Z',
  on_hold_expire_duration: null,
  data_limit_reset_strategy: 'no_reset',
  created_at: '2026-11-01T00:00:00Z',
  edit_at: null,
  proxy_settings: { vless: { secret: secret } },
  subscription_url: secret,
  note: secret,
});
const mock = (
  handler: (url: URL, opts: RequestInit) => Response | Promise<Response>,
) =>
  new PasarguardOpeningBaselineDirectory(
    'https://pasar.example.invalid/',
    '/test/key',
    (url, options) =>
      Promise.resolve(
        handler(
          new URL(
            url instanceof Request
              ? url.url
              : url instanceof URL
                ? url.href
                : url,
          ),
          options ?? {},
        ),
      ),
    () => Promise.resolve(secret),
  );

describe('PasarGuard opening baseline official API', () => {
  it('enumerates stable numeric IDs with a read-only, sorted simple list', async () => {
    const client = mock((url, opts) => {
      expect(url.pathname).toBe('/api/users/simple');
      expect(url.searchParams.get('sort')).toBe('id');
      expect(url.searchParams.get('offset')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(opts.method).toBe('GET');
      expect(opts.redirect).toBe('error');
      expect(new Headers(opts.headers).get('X-Api-Key')).toBe(secret);
      return Response.json({ users: [{ id: 1 }, { id: 2 }], total: 2 });
    });
    expect(await client.listIds(0, 50)).toEqual({ ids: ['1', '2'], total: 2 });
  });

  it('hydrates only selected IDs and discards sensitive fields', async () => {
    const client = mock((url) => {
      expect(url.pathname).toBe('/api/users');
      expect(url.searchParams.getAll('ids')).toEqual(['7', '8']);
      expect(url.searchParams.get('limit')).toBe('2');
      return Response.json({ users: [user(8), user(7)], total: 2 });
    });
    const rows = await client.details(['7', '8']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      externalUserId: '8',
      billingAdminId: '17',
      dataLimitBytes: '53687091200',
      usedTrafficBytes: '1000',
      onHoldDurationSeconds: null,
      sourceEditedAt: null,
    });
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts a requested user disappearing during a live source read', async () => {
    const client = mock(() => Response.json({ users: [user(7)], total: 2 }));
    expect(
      (await client.details(['7', '8'])).map((u) => u.externalUserId),
    ).toEqual(['7']);
  });

  it.each([
    ['total above requested roster', { users: [user(7)], total: 3 }],
    ['duplicate record', { users: [user(7), user(7)], total: 2 }],
    ['unrelated ID', { users: [user(7), user(9)], total: 2 }],
    [
      'missing billing identity',
      { users: [{ ...user(7), admin: undefined }, user(8)], total: 2 },
    ],
    [
      'unsafe amount',
      {
        users: [
          { ...user(7), data_limit: Number.MAX_SAFE_INTEGER + 1 },
          user(8),
        ],
        total: 2,
      },
    ],
  ])('fails closed for %s', async (_label, response) => {
    await expect(
      mock(() => Response.json(response)).details(['7', '8']),
    ).rejects.toBeInstanceOf(OpeningBaselineUnavailable);
  });

  it('fails closed for duplicate, unsorted and partial identity pages', async () => {
    for (const users of [
      [{ id: 2 }, { id: 1 }],
      [{ id: 1 }, { id: 1 }],
      [{ id: -1 }],
    ]) {
      await expect(
        mock(() => Response.json({ users, total: 2 })).listIds(0, 50),
      ).rejects.toBeInstanceOf(OpeningBaselineUnavailable);
    }
  });

  it('rejects oversized responses, redirects, bad schemes and malformed credentials', async () => {
    await expect(
      mock(() => new Response('x'.repeat(2_000_010))).listIds(0, 50),
    ).rejects.toBeInstanceOf(OpeningBaselineUnavailable);
    await expect(
      mock(() => Response.redirect('https://evil.invalid')).listIds(0, 50),
    ).rejects.toBeInstanceOf(OpeningBaselineUnavailable);
    expect(
      () =>
        new PasarguardOpeningBaselineDirectory('http://pasar.invalid/', '/key'),
    ).toThrow('INVALID_OPENING_BASELINE_SOURCE');
    await expect(
      new PasarguardOpeningBaselineDirectory(
        'https://pasar.invalid/',
        '/key',
        () => Promise.resolve(Response.json({ users: [], total: 0 })),
        () => Promise.resolve('bad\r\nkey'),
      ).listIds(0, 50),
    ).rejects.toBeInstanceOf(OpeningBaselineUnavailable);
  });
});

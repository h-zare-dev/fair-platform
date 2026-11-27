import { afterEach, describe, expect, it } from 'vitest';
import {
  DirectoryUnavailable,
  PasarguardAdminDirectory,
  type AdminDirectory,
} from '../../apps/api/dist/owner/infrastructure/admin-directory.js';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import type { OwnerAuth } from '../../apps/api/dist/owner/application/auth.js';
import type { OperationsReader } from '../../apps/api/dist/owner/application/operations.js';

const valid = { admins: [{ id: 17, username: 'synthetic_admin' }], total: 1 };
const query = { search: 'admin', offset: 0, limit: 25 };
const key = 'synthetic-contract-test-secret';
const readKey = () => Promise.resolve(key);

function adapter(
  reply: (url: URL, options: RequestInit) => Promise<Response> | Response,
) {
  return new PasarguardAdminDirectory(
    'https://pasar.example.invalid/',
    '/run/secrets/pasarguard_api_key',
    (input, options) =>
      Promise.resolve(
        reply(
          new URL(input instanceof Request ? input.url : input.toString()),
          options ?? {},
        ),
      ),
    readKey,
  );
}

describe('bounded, read-only PasarGuard admin directory', () => {
  it('calls ONLY the fixed official GET path with X-Api-Key and returns allowlisted fields', async () => {
    let seen = false;
    const directory = adapter((url, options) => {
      seen = true;
      expect(url.origin).toBe('https://pasar.example.invalid');
      expect(url.pathname).toBe('/api/admins/simple');
      expect(url.searchParams.get('search')).toBe('admin');
      expect(url.searchParams.get('offset')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('25');
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
      expect(options.credentials).toBe('omit');
      expect(new Headers(options.headers).get('X-Api-Key')).toBe(key);
      return Response.json({
        ...valid,
        admins: [{ ...valid.admins[0], role: 'PRIVATE', password: key }],
        hidden: key,
      });
    });
    expect(await directory.list(query)).toEqual({
      status: 'available',
      admins: [{ id: '17', username: 'synthetic_admin' }],
      total: 1,
      offset: 0,
      limit: 25,
    });
    expect(seen).toBe(true);
  });

  it('allows an empty page without inventing a manager', async () => {
    const directory = adapter(() => Response.json({ admins: [], total: 0 }));
    expect((await directory.list({ ...query, search: '' })).admins).toEqual([]);
  });

  it.each([
    ['expired key', () => Response.json({ detail: 'no' }, { status: 401 })],
    ['no scope', () => Response.json({ detail: 'no' }, { status: 403 })],
    ['redirect', () => Response.redirect('https://evil.invalid/', 302)],
    ['upstream error', () => Response.json({}, { status: 500 })],
    ['bad shape', () => Response.json({ admins: 'broken', total: 1 })],
    [
      'bad ID',
      () => Response.json({ admins: [{ id: -1, username: 'a' }], total: 1 }),
    ],
    [
      'duplicate IDs',
      () =>
        Response.json({
          admins: [
            { id: 1, username: 'a' },
            { id: 1, username: 'b' },
          ],
          total: 2,
        }),
    ],
    [
      'bad username',
      () => Response.json({ admins: [{ id: 1, username: '' }], total: 1 }),
    ],
    [
      'too many returned for limit',
      () =>
        Response.json({
          admins: [valid.admins[0], { id: 2, username: 'b' }],
          total: 2,
        }),
    ],
    [
      'oversized total',
      () => Response.json({ admins: [], total: 1_000_000_001 }),
    ],
  ])('fails closed for %s', async (_name, responder) => {
    const directory = adapter(responder);
    await expect(directory.list({ ...query, limit: 1 })).rejects.toBeInstanceOf(
      DirectoryUnavailable,
    );
  });

  it('caps upstream body size and handles network timeouts without leaking details', async () => {
    await expect(
      adapter(() => new Response('x'.repeat(70_000))).list(query),
    ).rejects.toThrow('DIRECTORY_UNAVAILABLE');
    await expect(
      adapter(() => Promise.reject(new Error(`upstream failed: ${key}`))).list(
        query,
      ),
    ).rejects.toThrow('DIRECTORY_UNAVAILABLE');
  });

  it('rejects redirects-in-configuration, query injection hosts, plain HTTP and embedded credentials', () => {
    for (const url of [
      'http://pasar.example.invalid',
      'https://user:pass@pasar.example.invalid/',
      'https://pasar.example.invalid/private',
      'https://pasar.example.invalid/?next=https://other.invalid',
      'https://pasar.example.invalid/#fragment',
    ])
      expect(
        () => new PasarguardAdminDirectory(url, '/run/secrets/key'),
      ).toThrow('INVALID_DIRECTORY_BASE_URL');
  });

  it('returns unavailable if the runtime secret file is absent or malformed', async () => {
    const http: typeof fetch = () =>
      Promise.reject(new Error('must not fetch with missing key'));
    const directory = new PasarguardAdminDirectory(
      'https://pasar.example.invalid/',
      '/run/secrets/key',
      http,
      () => Promise.reject(new Error('ENOENT')),
    );
    await expect(directory.list(query)).rejects.toThrow(
      'DIRECTORY_UNAVAILABLE',
    );
  });
});

describe('Owner-only directory API boundary', () => {
  let app: Awaited<ReturnType<typeof createOwnerApi>>;
  const auth = {
    authenticated: (token: string | null) =>
      Promise.resolve(token === 'synthetic-session'),
  } as OwnerAuth;
  const reader = {
    ready: async () => {},
  } as OperationsReader;
  const directory: AdminDirectory = {
    list: (q) =>
      Promise.resolve({
        status: 'available',
        admins: [{ id: '17', username: 'synthetic_admin' }],
        total: 1,
        ...q,
      }),
  };
  afterEach(async () => {
    if (app) await app.close();
  });

  it('requires Owner authentication and bounds search, pagination and URL parameters', async () => {
    app = await createOwnerApi(
      auth,
      reader,
      'https://panel.fairisfair.ir',
      undefined,
      undefined,
      directory,
    );
    const url = '/api/v1/owner/directory/admins?search=admin&offset=0&limit=25';
    expect((await app.inject(url)).statusCode).toBe(401);
    const headers = { cookie: `${COOKIE}=synthetic-session` };
    const success = await app.inject({ url, headers });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({
      status: 'available',
      admins: [{ id: '17', username: 'synthetic_admin' }],
      total: 1,
      search: 'admin',
      offset: 0,
      limit: 25,
    });
    expect(success.headers['cache-control']).toBe('no-store');
    for (const bad of [
      '?url=https://evil.invalid',
      '?search=' + 'a'.repeat(65),
      '?limit=500',
      '?offset=-1',
      '?search=%0A',
    ])
      expect(
        (
          await app.inject({
            url: `/api/v1/owner/directory/admins${bad}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
  });

  it('is explicitly unavailable without configured secret/endpoint', async () => {
    app = await createOwnerApi(auth, reader, 'https://panel.fairisfair.ir');
    const response = await app.inject({
      url: '/api/v1/owner/directory/admins',
      headers: { cookie: `${COOKIE}=synthetic-session` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ message: 'DIRECTORY_UNAVAILABLE' });
  });
});

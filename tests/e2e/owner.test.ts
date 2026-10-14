import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPostgres } from '../helpers/postgres.js';
import { createOwnerDataSource } from '../../apps/api/dist/owner/infrastructure/database.js';
import { PostgresOwnerAuth } from '../../apps/api/dist/owner/infrastructure/auth-store.js';
import { passwords } from '../../apps/api/dist/owner/infrastructure/password.js';
import { PostgresOwnerOperations } from '../../apps/api/dist/owner/infrastructure/operations.js';
import {
  OwnerAuth,
  tokenHash,
} from '../../apps/api/dist/owner/application/auth.js';
import { createOwnerApi, COOKIE } from '../../apps/api/dist/owner/app.js';
import { seedSynthetic } from '../../apps/api/dist/owner/infrastructure/seed.js';
import { operationFilter } from '../../apps/api/dist/owner/application/operations.js';
let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof createOwnerDataSource>;
let app: Awaited<ReturnType<typeof createOwnerApi>>;
let auth: OwnerAuth;
let store: PostgresOwnerAuth;
let reader: PostgresOwnerOperations;
const origin = 'https://panel.fairisfair.ir';
const headers = {
  origin,
  'content-type': 'application/json',
  'x-fair-csrf': '1',
};
// Synthetic test-only password; never an operator credential.
const password = 'synthetic-test-only-long-password';
let hash: string;
beforeAll(async () => {
  container = await startPostgres();
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  await db.runMigrations({ transaction: 'all' });
  hash = await passwords.hash(password);
  store = new PostgresOwnerAuth(db);
  reader = new PostgresOwnerOperations(db);
  auth = new OwnerAuth(
    store,
    passwords,
    await passwords.hash('dummy-test-only'),
  );
  app = await createOwnerApi(auth, reader, origin);
}, 120000);
afterAll(async () => {
  if (app) await app.close();
  if (db?.isInitialized) await db.destroy();
  if (container) await container.stop();
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE fair_owner_sessions,fair_owner,fair_owner_audit,fair_owner_login_budget,fair_synthetic_seed,pasarguard_ingestion_issues,pasarguard_events,pasarguard_webhook_batches RESTART IDENTITY',
  );
});
async function login(cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload: { password },
  });
}
function cookieOf(response: { headers: Record<string, unknown> }) {
  return String(response.headers['set-cookie']).split(';')[0]!;
}
it('PostgreSQL singleton rejects concurrent and subsequent bootstrap and arbitrary IDs', async () => {
  const result = await Promise.all(
    Array.from({ length: 12 }, () => store.bootstrap(hash)),
  );
  expect(result.filter(Boolean)).toHaveLength(1);
  expect(await auth.bootstrap(password)).toBe(false);
  expect(await db.query('SELECT id FROM fair_owner')).toEqual([{ id: 1 }]);
  await expect(
    db.query('INSERT INTO fair_owner (id,password_hash) VALUES (2,$1)', [hash]),
  ).rejects.toThrow();
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(await passwords.verify(hash, password)).toBe(true);
});
it('CSRF rejects foreign/missing origin, plain forms and forwarded spoofing; no public signup/reset or webhook', async () => {
  await store.bootstrap(hash);
  for (const h of [
    {},
    { ...headers, origin: 'https://evil.invalid' },
    { ...headers, 'x-fair-csrf': '0' },
    { origin, 'content-type': 'text/plain', 'x-fair-csrf': '1' },
    {
      ...headers,
      origin: 'http://panel.fairisfair.ir',
      'x-forwarded-proto': 'https',
    },
  ]) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/owner/auth/login',
          headers: h,
          payload: JSON.stringify({ password }),
        })
      ).statusCode,
    ).toSatisfy((status: number) => [403, 415].includes(status));
  }
  for (const route of [
    'auth/register',
    'auth/reset-password',
    'auth/create-account',
  ])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/owner/${route}`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/pasarguard',
        payload: [],
      })
    ).statusCode,
  ).toBe(404);
});
it('unauthorized, fixation, rotation, hash-only persistence, cookies, logout and restart', async () => {
  for (const route of [
    'auth/session',
    'operations/summary',
    'operations/events',
    'operations/issues',
  ])
    expect((await app.inject(`/api/v1/owner/${route}`)).statusCode).toBe(401);
  await store.bootstrap(hash);
  const first = await login(`${COOKIE}=attacker-fixed`);
  expect(first.statusCode).toBe(201);
  const cookie = cookieOf(first);
  expect(String(first.headers['set-cookie'])).toContain(
    'Secure; HttpOnly; SameSite=Strict',
  );
  expect(first.headers['cache-control']).toBe('no-store');
  const rows: { token_hash: string }[] = await db.query(
    'SELECT token_hash FROM fair_owner_sessions',
  );
  expect(rows[0]?.token_hash).toBe(tokenHash(cookie.split('=')[1]!));
  await app.close();
  app = await createOwnerApi(auth, reader, origin);
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  const second = await login(cookie);
  const rotated = cookieOf(second);
  expect(rotated).not.toBe(cookie);
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/owner/auth/logout',
        headers: { ...headers, cookie: rotated },
        payload: {},
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie: rotated },
      })
    ).statusCode,
  ).toBe(401);
});
it('idle and absolute expiry, trusted reset/revoke and cleanup reject sessions', async () => {
  await store.bootstrap(hash);
  for (const update of [
    "last_seen_at=now()-interval '31 minutes'",
    "created_at=now()-interval '13 hours',expires_at=now()-interval '1 hour'",
  ]) {
    const cookie = cookieOf(await login());
    await db.query(`UPDATE fair_owner_sessions SET ${update}`);
    expect(
      (
        await app.inject({
          url: '/api/v1/owner/auth/session',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
    await store.cleanup();
    expect(
      await db.query('SELECT token_hash FROM fair_owner_sessions'),
    ).toEqual([]);
  }
  const cookie = cookieOf(await login());
  await store.reset(await passwords.hash('replacement-synthetic-password'));
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(401);
  expect((await login()).statusCode).toBe(401);
  await store.reset(hash);
  const revoked = cookieOf(await login());
  await store.revoke();
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie: revoked },
      })
    ).statusCode,
  ).toBe(401);
});
it('reset wins against in-flight password verification', async () => {
  await store.bootstrap(hash);
  const old = await store.passwordHash();
  await store.reset(await passwords.hash('replacement-synthetic-password'));
  expect(await store.login(old!, 'a'.repeat(64), null)).toBe(false);
  expect(await db.query('SELECT token_hash FROM fair_owner_sessions')).toEqual(
    [],
  );
});
it('shared throttle atomically bounds concurrent login attempts across processes', async () => {
  const other = new PostgresOwnerAuth(db);
  const allowed = await Promise.all(
    Array.from({ length: 40 }, (_, n) => (n % 2 ? store : other).attempt()),
  );
  expect(allowed.filter(Boolean)).toHaveLength(10);
  expect((await login()).statusCode).toBe(429);
  await db.query(
    "UPDATE fair_owner_login_budget SET started_at=now()-interval '2 minutes'",
  );
  expect(await other.attempt()).toBe(true);
});
it('generic login failures and malformed JSON never disclose sensitive input', async () => {
  const absent = await login();
  await store.bootstrap(hash);
  const wrong = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    headers,
    payload: { password: 'synthetic-wrong' },
  });
  expect(absent.body).toBe(wrong.body);
  expect(absent.statusCode).toBe(401);
  const malformed = await app.inject({
    method: 'POST',
    url: '/api/v1/owner/auth/login',
    headers,
    payload: '{"password":"synthetic-private-marker", broken}',
  });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('synthetic-private-marker');
  const audit = JSON.stringify(
    await db.query('SELECT * FROM fair_owner_audit'),
  );
  expect(audit).not.toContain(password);
  expect(audit).not.toContain(hash);
});
it('synthetic seed is idempotent and summary counts respect source and half-open boundaries', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  await seedSynthetic(db, '11'.repeat(32));
  expect(
    await db.query('SELECT count(*)::int AS n FROM pasarguard_events'),
  ).toEqual([{ n: 11 }]);
  expect(
    await db.query('SELECT count(*)::int AS n FROM pasarguard_webhook_batches'),
  ).toEqual([{ n: 12 }]);
  const range = {
    start: '2026-10-01T00:00:00.000Z',
    end: '2026-10-02T00:00:00.000Z',
    source: 'synthetic-fp003b',
  };
  await db.query(
    "UPDATE pasarguard_webhook_batches SET received_at='2026-10-01T00:00:00Z',processing_status='FAILED_RETRYABLE'",
  );
  await db.query(
    "UPDATE pasarguard_webhook_batches SET received_at='2026-10-02T00:00:00Z' WHERE id=1",
  );
  await db.query(
    "UPDATE pasarguard_events SET created_at='2026-10-01T00:00:00Z',source_enqueued_at='2026-09-01T00:00:00Z'",
  );
  await db.query(
    "UPDATE pasarguard_ingestion_issues SET created_at='2026-10-01T00:00:00Z'",
  );
  const s = await reader.summary(operationFilter(range, 'summary'));
  expect(s).toMatchObject({
    receivedBatches: '11',
    normalizedEvents: '11',
    failedBatches: '11',
    openIngestionIssues: '2',
  });
  expect(
    (await reader.events(operationFilter(range, 'events'))).rows,
  ).toHaveLength(0);
  expect(
    await reader.summary(
      operationFilter({ ...range, source: 'other' }, 'summary'),
    ),
  ).toMatchObject({
    receivedBatches: '0',
    normalizedEvents: '0',
    openIngestionIssues: '0',
  });
});
it('microsecond/tied timestamp cursors never skip rows and projections omit private fields', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  await store.bootstrap(hash);
  const cookie = cookieOf(await login());
  await db.query(
    "UPDATE pasarguard_events SET source_enqueued_at='2026-10-01T00:00:00.000123Z'",
  );
  await db.query(
    "UPDATE pasarguard_events SET source_enqueued_at='2026-10-01T00:00:00.000124Z' WHERE id=1",
  );
  const query = {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-02T00:00:00Z',
    limit: '1',
  };
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const p = await reader.events(
      operationFilter({ ...query, ...(cursor ? { cursor } : {}) }, 'events'),
    );
    expect(p.rows).toHaveLength(1);
    expect(ids.has(p.rows[0]!.id)).toBe(false);
    ids.add(p.rows[0]!.id);
    cursor = p.nextCursor;
  } while (cursor);
  expect(ids.size).toBe(11);
  const response = await app.inject({
    url:
      '/api/v1/owner/operations/events?' +
      new URLSearchParams(query).toString(),
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  for (const forbidden of [
    'username',
    'semantic_fingerprint',
    'raw_payload',
    'ciphertext',
    'subscription_url',
    'password_hash',
  ])
    expect(response.body).not.toContain(forbidden);
  await db.query(
    "UPDATE pasarguard_ingestion_issues SET issue_code='synthetic-private-marker',issue_message='synthetic-private-marker',created_at='2026-10-01T00:00:00Z'",
  );
  const issues = await reader.issues(operationFilter(query, 'issues'));
  expect(JSON.stringify(issues)).not.toContain('synthetic-private-marker');
});
it('unknown stored issue codes always project fixed string code and message', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  for (const code of [
    '__proto__',
    'constructor',
    'toString',
    '',
    'unrecognized',
  ]) {
    await db.query('UPDATE pasarguard_ingestion_issues SET issue_code=$1', [
      code,
    ]);
    const issues = await reader.issues(
      operationFilter({ window: '24h' }, 'issues'),
    );
    expect(issues.rows.length).toBeGreaterThan(0);
    for (const row of issues.rows) {
      expect(row.code).toBe('INGESTION_ISSUE');
      expect(row.message).toBe('Event requires review');
      expect(typeof row.message).toBe('string');
    }
  }
});
it('strict pagination/range validation and database outage fail safely', async () => {
  await store.bootstrap(hash);
  const cookie = cookieOf(await login());
  for (const q of [
    'start=0000-01-01T00%3A00%3A00Z&end=0000-01-02T00%3A00%3A00Z',
    'limit=101',
    'limit=-1',
    'cursor=e30',
    'sort=password_hash',
    'start=2026-10-01T00%3A00%3A00Z',
    'start=2026-01-01T00%3A00%3A00Z&end=2026-10-01T00%3A00%3A00Z',
  ])
    expect(
      (
        await app.inject({
          url: '/api/v1/owner/operations/events?' + q,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
  await db.query(
    'ALTER TABLE fair_owner_sessions RENAME TO temporarily_unavailable',
  );
  try {
    expect(
      (
        await app.inject({
          url: '/api/v1/owner/auth/session',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(503);
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  } finally {
    await db.query(
      'ALTER TABLE temporarily_unavailable RENAME TO fair_owner_sessions',
    );
  }
});
it('additive migrations upgrade prior schema and reverse only in disposable DB', async () => {
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('owner_events_all_source_time')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query("SELECT to_regclass('fair_owner')::text AS name"),
  ).toEqual([{ name: null }]);
  expect(
    await db.query("SELECT to_regclass('pasarguard_events')::text AS name"),
  ).toEqual([{ name: 'pasarguard_events' }]);
  await db.runMigrations({ transaction: 'all' });
  await reader.ready();
});

it('runtime database role can authenticate and read operations but cannot mutate business tables or Owner credentials', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  await store.bootstrap(hash);
  const databaseName = new URL(container.getConnectionUri()).pathname.slice(1);
  await db.query(
    readFileSync('docker/staging/runtime-grants.sql', 'utf8').replaceAll(
      'fair_staging',
      databaseName,
    ),
  );
  await db.query(
    "ALTER ROLE fair_owner_runtime PASSWORD 'synthetic-role-test-password'",
  );
  const url = new URL(container.getConnectionUri());
  url.username = 'fair_owner_runtime';
  url.password = 'synthetic-role-test-password';
  const runtime = createOwnerDataSource(url.toString());
  await runtime.initialize();
  try {
    const runtimeStore = new PostgresOwnerAuth(runtime);
    const runtimeAuth = new OwnerAuth(runtimeStore, passwords, hash);
    const result = await runtimeAuth.login(password, null);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok')
      expect(await runtimeAuth.authenticated(result.token)).toBe(true);
    const runtimeReader = new PostgresOwnerOperations(runtime);
    await runtimeReader.ready();
    expect(
      await runtimeReader.summary(operationFilter({}, 'summary')),
    ).toMatchObject({ receivedBatches: '12', normalizedEvents: '11' });
    await runtimeReader.events(operationFilter({}, 'events'));
    await runtimeReader.issues(operationFilter({}, 'issues'));
    await runtimeStore.cleanup();
    for (const sql of [
      'UPDATE pasarguard_events SET occurrence_count=2',
      'DELETE FROM pasarguard_webhook_batches',
      "UPDATE fair_owner SET password_hash='x'",
      'SELECT raw_payload_ciphertext FROM pasarguard_webhook_batches',
      'SELECT username FROM pasarguard_events',
    ])
      await expect(runtime.query(sql)).rejects.toThrow();
  } finally {
    await runtime.destroy();
  }
});

it('readiness fails when any required operational table is unavailable', async () => {
  for (const table of [
    'pasarguard_webhook_batches',
    'pasarguard_ingestion_issues',
  ]) {
    await db.query(`ALTER TABLE ${table} RENAME TO temporarily_unavailable`);
    try {
      expect((await app.inject('/health/ready')).statusCode).toBe(503);
      expect((await app.inject('/health/live')).statusCode).toBe(200);
    } finally {
      await db.query(`ALTER TABLE temporarily_unavailable RENAME TO ${table}`);
    }
  }
});

it('PostgreSQL container restart retains synthetic rows and server-side sessions', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  await store.bootstrap(hash);
  const cookie = cookieOf(await login());
  await app.close();
  await db.destroy();
  await container.restart();
  // Docker can allocate a different disposable host port on restart.
  db = createOwnerDataSource(container.getConnectionUri());
  await db.initialize();
  store = new PostgresOwnerAuth(db);
  reader = new PostgresOwnerOperations(db);
  auth = new OwnerAuth(store, passwords, hash);
  app = await createOwnerApi(auth, reader, origin);
  expect(
    (
      await app.inject({
        url: '/api/v1/owner/auth/session',
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await db.query('SELECT count(*)::int AS n FROM pasarguard_events'),
  ).toEqual([{ n: 11 }]);
}, 60000);

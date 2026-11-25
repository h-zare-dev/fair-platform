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
it('authenticated password change validates current password and policy, revokes every session, and audits', async () => {
  await store.bootstrap(hash);
  const first = cookieOf(await login());
  const second = cookieOf(await login());
  const change = (
    cookie: string,
    currentPassword: string,
    newPassword: string,
    requestHeaders = headers,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/owner/auth/change-password',
      headers: { ...requestHeaders, cookie },
      payload: { currentPassword, newPassword },
    });
  expect((await change('', password, 'Newpassword123')).statusCode).toBe(401);
  expect((await change(first, password, 'short')).statusCode).toBe(400);
  expect((await change(first, password, 'allletters')).statusCode).toBe(400);
  expect((await change(first, password, '12345678')).statusCode).toBe(400);
  expect((await change(first, password, password)).statusCode).toBe(400);
  expect(
    (
      await change(first, password, 'Newpassword123', {
        ...headers,
        origin: 'https://evil.invalid',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await change(first, 'wrong-current', 'Newpassword123')).statusCode,
  ).toBe(401);
  expect((await login()).statusCode).toBe(201);
  const success = await change(first, password, 'Newpassword123');
  expect(success.statusCode).toBe(201);
  expect(success.headers['set-cookie']).toContain('Max-Age=0');
  for (const cookie of [first, second])
    expect(
      (
        await app.inject({
          url: '/api/v1/owner/auth/session',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
  expect((await login()).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/owner/auth/login',
        headers,
        payload: { password: 'Newpassword123' },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    await db.query(
      "SELECT event FROM fair_owner_audit WHERE event='CHANGE_PASSWORD'",
    ),
  ).toHaveLength(1);
  expect(
    (await change(second, 'Newpassword123', 'Anotherpass123')).statusCode,
  ).toBe(401);
});
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
it('the fixed 30-day import requires Owner session and CSRF, and never invokes the live webhook', async () => {
  const received: { payload: unknown; at: Date }[] = [];
  await app.close();
  app = await createOwnerApi(
    auth,
    reader,
    origin,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      receive: (payload: unknown, at: Date) => {
        received.push({ payload, at });
        return Promise.resolve();
      },
    } as Parameters<typeof createOwnerApi>[8],
  );
  const url = '/api/v1/owner/webhook/pasarguard';
  const uploadHeaders = {
    ...headers,
    'x-fair-replay-import':
      'fa845d0a2276e65ff7ca4c77fc253c289309541ed3367d752ab3ee4af190e242',
  };
  const payload = {
    records: [
      {
        receivedAt: '2026-11-20T12:00:00Z',
        payload: [{ action: 'user_created' }],
      },
    ],
  };
  expect(
    (await app.inject({ method: 'POST', url, headers: uploadHeaders, payload }))
      .statusCode,
  ).toBe(401);
  await store.bootstrap(hash);
  const cookie = cookieOf(await login());
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...uploadHeaders, cookie, origin: 'https://evil.invalid' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: {
          ...headers,
          cookie,
          'x-fair-replay-import': 'not-the-approved-file',
        },
        payload,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...uploadHeaders, cookie },
        payload: {
          records: [{ receivedAt: '2020-01-01T00:00:00Z', payload: [{}] }],
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(received).toHaveLength(0);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { ...uploadHeaders, cookie },
        payload,
      })
    ).statusCode,
  ).toBe(202);
  expect(received).toHaveLength(1);
  expect(received[0]?.at.toISOString()).toBe('2026-11-20T12:00:00.000Z');
  await app.close();
  app = await createOwnerApi(auth, reader, origin);
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
it('historical dashboard counts use batch receipt, while processing throughput uses server time', async () => {
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
    "UPDATE pasarguard_events SET created_at=now(),source_enqueued_at='2026-09-01T00:00:00Z'",
  );
  await db.query('UPDATE pasarguard_ingestion_issues SET created_at=now()');
  const s = await reader.summary(operationFilter(range, 'summary'));
  expect(s).toMatchObject({
    receivedBatches: '11',
    normalizedEvents: '10',
    processedBatches: '0',
    processedLast24h: '11',
    failedBatches: '11',
    openIngestionIssues: '2',
  });
  expect(
    (await reader.events(operationFilter(range, 'events'))).rows,
  ).toHaveLength(10);
  expect(
    (await reader.issues(operationFilter(range, 'issues'))).rows,
  ).toHaveLength(2);
  expect(
    await reader.summary(
      operationFilter({ ...range, source: 'other' }, 'summary'),
    ),
  ).toMatchObject({
    receivedBatches: '0',
    normalizedEvents: '0',
    processedBatches: '0',
    processedLast24h: '0',
    openIngestionIssues: '0',
  });
});
it('microsecond receipt-time cursors never skip events or issues, and projections omit private fields', async () => {
  await seedSynthetic(db, '11'.repeat(32));
  await store.bootstrap(hash);
  const cookie = cookieOf(await login());
  await db.query(
    "UPDATE pasarguard_webhook_batches SET received_at='2026-10-01T00:00:00.000123Z'",
  );
  await db.query(
    "UPDATE pasarguard_webhook_batches SET received_at='2026-10-01T00:00:00.000124Z' WHERE id=1",
  );
  await db.query(
    "UPDATE pasarguard_events SET source_enqueued_at='2026-09-01T00:00:00Z'",
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
  const issueIds = new Set<string>();
  let issueCursor: string | null = null;
  do {
    const page = await reader.issues(
      operationFilter(
        { ...query, ...(issueCursor ? { cursor: issueCursor } : {}) },
        'issues',
      ),
    );
    for (const issue of page.rows) {
      expect(issueIds.has(issue.id)).toBe(false);
      issueIds.add(issue.id);
    }
    issueCursor = page.nextCursor;
  } while (issueCursor);
  expect(issueIds.size).toBe(2);
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
  // The runtime password grant is a separate, reversible additive migration.
  await db.undoLastMigration({ transaction: 'all' });
  // The archive migration adds immutable input metadata and manual reviews.
  // Reversal is exercised only on this disposable database.
  for (const table of [
    'fair_replay_archives',
    'fair_replay_shadow_manual_reviews',
    'fair_replay_shadow_manual_operations',
  ]) {
    expect(
      await db.query('SELECT to_regclass($1)::text AS name', [table]),
    ).toEqual([{ name: table }]);
  }
  await db.undoLastMigration({ transaction: 'all' });
  for (const table of [
    'fair_replay_archives',
    'fair_replay_shadow_manual_reviews',
    'fair_replay_shadow_manual_operations',
  ]) {
    expect(
      await db.query('SELECT to_regclass($1)::text AS name', [table]),
    ).toEqual([{ name: null }]);
  }
  // Undo the password-change allowlist before the earlier identity sidecar.
  await db.undoLastMigration({ transaction: 'all' });
  // Undo the private historical identity sidecar before the audit migration.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('fair_replay_private_identity_imports')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  expect(
    await db.query(
      "SELECT to_regclass('fair_replay_private_identity_aliases')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  // The Owner-only audit adds immutable price/candidate evidence after the
  // original SHADOW journal; unwind only in this disposable test database.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('fair_replay_shadow_audit_prices')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  // The combined FP-006/007 SHADOW trial adds two additive migrations after
  // the read-only opening snapshot; unwind those next.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('fair_replay_shadow_runs')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('fair_opening_baseline_control')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  // FP-006 adds the opening-baseline snapshot after FP-005 Shadow tables.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('fair_opening_baseline_users')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  expect(
    await db.query(
      "SELECT to_regclass('fair_opening_baseline_runs')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  // FP-005 adds immutable Shadow tables after the earlier group-delete guard.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query("SELECT to_regclass('fair_shadow_days')::text AS name"),
  ).toEqual([{ name: null }]);
  // The ingestion projection has a separate later timestamp than the
  // historical Owner catalog migrations; undo it before their assertions.
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regclass('pasarguard_create_closure')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query(
      "SELECT to_regprocedure('fair_unused_group_delete_guard()')::text AS name",
    ),
  ).toEqual([{ name: null }]);
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query("SELECT to_regclass('fair_atomic_packages')::text AS name"),
  ).toEqual([{ name: null }]);
  await db.undoLastMigration({ transaction: 'all' });
  expect(
    await db.query("SELECT to_regclass('fair_pricing_plans')::text AS name"),
  ).toEqual([{ name: null }]);
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

it('runtime role can ingest while core event fields and Owner credentials remain write-protected', async () => {
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
    if (result.kind === 'ok') {
      expect(await runtimeAuth.authenticated(result.token)).toBe(true);
      expect(
        await runtimeAuth.changePassword(
          'wrong-current',
          'Newpass123',
          result.token,
        ),
      ).toBe('denied');
      expect(
        await runtimeAuth.changePassword(password, 'Newpass123', result.token),
      ).toBe('ok');
      expect(await runtimeAuth.authenticated(result.token)).toBe(false);
      expect((await runtimeAuth.login(password, null)).kind).toBe('denied');
      expect((await runtimeAuth.login('Newpass123', null)).kind).toBe('ok');
    }
    const runtimeReader = new PostgresOwnerOperations(runtime);
    await runtimeReader.ready();
    expect(
      await runtimeReader.summary(operationFilter({}, 'summary')),
    ).toMatchObject({ receivedBatches: '12', normalizedEvents: '11' });
    await runtimeReader.events(operationFilter({}, 'events'));
    await runtimeReader.issues(operationFilter({}, 'issues'));
    await runtimeStore.cleanup();
    for (const sql of [
      'UPDATE pasarguard_events SET data_limit_bytes=2',
      "UPDATE pasarguard_events SET username='not-allowed'",
      'DELETE FROM pasarguard_webhook_batches',
      'UPDATE fair_owner SET id=2',
      'DELETE FROM fair_owner',
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

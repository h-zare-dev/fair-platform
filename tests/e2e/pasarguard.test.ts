import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  BatchEntity,
  BatchProcessor,
  EventEntity,
  PayloadEncryption,
  createDataSource,
} from '@fair-platform/pasarguard/infrastructure';
import { createApi } from '../../apps/api/dist/app.js';
import {
  DenyWebhookAuthenticator,
  DevelopmentWebhookAuthenticator,
} from '../../apps/api/dist/modules/webhooks/application/authenticator.js';
import { actorContractBatch, fixture } from '../helpers/fixtures.js';
import {
  configFor,
  migratedDatabase,
  startPostgres,
} from '../helpers/postgres.js';

let container: StartedPostgreSqlContainer;
let database: ReturnType<typeof createDataSource>;
let app: Awaited<ReturnType<typeof createApi>>;
beforeAll(async () => {
  container = await startPostgres();
  database = await migratedDatabase(container.getConnectionUri());
  app = await createApi(
    database,
    configFor(container.getConnectionUri()),
    new DevelopmentWebhookAuthenticator('test'),
  );
}, 120000);
afterAll(async () => {
  if (app) await app.close();
  if (database?.isInitialized) await database.destroy();
  if (container) await container.stop();
});
beforeEach(async () => {
  await database.query(
    'TRUNCATE pasarguard_ingestion_issues, pasarguard_events, pasarguard_webhook_batches RESTART IDENTITY',
  );
});

it('HTTP -> durable batch -> worker -> READY_FOR_ACCOUNTING, singleton and batch', async () => {
  for (const payload of [fixture(), fixture('batch-events')]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pasarguard',
      payload,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  }
  expect(await database.getRepository(BatchEntity).count()).toBe(2);
  expect(await database.getRepository(EventEntity).count()).toBe(0);
  const worker = new BatchProcessor(
    database,
    new PayloadEncryption('11'.repeat(32)),
    5,
  );
  while (await worker.processNext()) {
    /* Drain the durable inbox. */
  }
  expect(
    await database
      .getRepository(EventEntity)
      .countBy({ event_status: 'READY_FOR_ACCOUNTING' }),
  ).toBe(3);
});
it('malformed JSON and unsupported top-level envelopes return 400', async () => {
  for (const payload of [[], { events: [fixture()] }, 'null', '{']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pasarguard',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(await database.getRepository(BatchEntity).count()).toBe(0);
});
it('auth denies before persistence and health exposes no payload', async () => {
  const denied = await createApi(
    database,
    configFor(container.getConnectionUri()),
    new DenyWebhookAuthenticator(),
  );
  try {
    const response = await denied.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pasarguard',
      payload: fixture(),
    });
    expect(response.statusCode).toBe(401);
    expect(await database.getRepository(BatchEntity).count()).toBe(0);
    expect((await denied.inject('/health/live')).statusCode).toBe(200);
    expect((await denied.inject('/health/ready')).statusCode).toBe(200);
  } finally {
    await denied.close();
  }
});
it('a database transaction failure never receives a successful HTTP acknowledgement', async () => {
  await database.query(
    "CREATE FUNCTION fp001_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-marker'; END $$",
  );
  await database.query(
    'CREATE TRIGGER fp001_fail BEFORE INSERT ON pasarguard_webhook_batches FOR EACH ROW EXECUTE FUNCTION fp001_fail_batch()',
  );
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pasarguard',
      payload: fixture(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('synthetic-private-marker');
    expect(await database.getRepository(BatchEntity).count()).toBe(0);
  } finally {
    await database.query(
      'DROP TRIGGER fp001_fail ON pasarguard_webhook_batches',
    );
    await database.query('DROP FUNCTION fp001_fail_batch()');
  }
});
it('duplicate deliveries return the same 202 and retain one batch', async () => {
  for (let index = 0; index < 2; index++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/pasarguard',
          payload: fixture(),
        })
      ).statusCode,
    ).toBe(202);
  expect(await database.getRepository(BatchEntity).count()).toBe(1);
});

it('malformed JSON cannot reflect a sensitive input fragment in an error response', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/pasarguard',
    headers: { 'content-type': 'application/json' },
    payload: '{"subscription_url":"synthetic-sensitive-marker", broken}',
  });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain('synthetic-sensitive-marker');
  expect(response.body).not.toContain('subscription_url');
});

it('FP-001B monthly reset and delete retain nullable Actor attribution through HTTP and worker', async () => {
  const reset: Record<string, unknown> = {
    ...fixture(),
    action: 'data_usage_reset',
    by: { id: null, username: 'synthetic-actor' },
  };
  (reset.user as Record<string, unknown>).data_limit_reset_strategy = 'month';
  const payload = [
    reset,
    { ...reset, action: 'user_deleted' },
    { ...reset, by: { id: null } },
  ];
  for (let delivery = 0; delivery < 2; delivery++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/webhooks/pasarguard',
          payload,
        })
      ).statusCode,
    ).toBe(202);
  const worker = new BatchProcessor(
    database,
    new PayloadEncryption('11'.repeat(32)),
    5,
  );
  await worker.processNext();
  const rows = await database.getRepository(EventEntity).find();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.actor_admin_id).toBeNull();
    expect(row.actor_admin_username).toBe('synthetic-actor');
    expect(row.billing_admin_id).toBe('501');
    expect(row.event_status).toBe('READY_FOR_ACCOUNTING');
  }
  expect(await database.getRepository(BatchEntity).count()).toBe(1);
});

it('FP-001B HTTP batch isolates invalid Actor and Billing Admin identities', async () => {
  const { payload, accepted } = actorContractBatch();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/pasarguard',
        payload,
      })
    ).statusCode,
  ).toBe(202);
  await new BatchProcessor(
    database,
    new PayloadEncryption('11'.repeat(32)),
    5,
  ).processNext();
  const rows = await database
    .getRepository(EventEntity)
    .find({ order: { id: 'ASC' } });
  expect(rows.map((row) => Number(row.external_user_id))).toEqual(accepted);
  expect(rows.map((row) => row.actor_admin_id)).toEqual([
    '502',
    null,
    null,
    null,
  ]);
  expect(rows.map((row) => row.actor_admin_username)).toEqual([
    'synthetic-actor',
    'synthetic-actor',
    null,
    null,
  ]);
  expect(
    rows.every(
      (row) =>
        row.billing_admin_id === '501' &&
        row.event_status === 'READY_FOR_ACCOUNTING',
    ),
  ).toBe(true);
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  BatchEntity,
  BatchProcessor,
  DurableInbox,
  EventEntity,
  IssueEntity,
  PayloadEncryption,
  createDataSource,
} from '@fair-platform/pasarguard/infrastructure';
import {
  fixture,
  nulBearingEvent,
  projectedTextPaths,
} from '../helpers/fixtures.js';
import {
  configFor,
  migratedDatabase,
  startPostgres,
} from '../helpers/postgres.js';

let container: StartedPostgreSqlContainer;
let database: ReturnType<typeof createDataSource>;
let inbox: DurableInbox;
const encryption = new PayloadEncryption('11'.repeat(32));
const processor = () => new BatchProcessor(database, encryption, 3);
beforeAll(async () => {
  container = await startPostgres();
  database = await migratedDatabase(container.getConnectionUri());
  inbox = new DurableInbox(
    database,
    encryption,
    configFor(container.getConnectionUri()),
  );
}, 120000);
afterAll(async () => {
  if (database?.isInitialized) await database.destroy();
  if (container) await container.stop();
});
beforeEach(async () => {
  await database.query(
    'TRUNCATE pasarguard_ingestion_issues, pasarguard_events, pasarguard_webhook_batches RESTART IDENTITY',
  );
});

describe('PostgreSQL 17 durable inbox', () => {
  it('migrates an empty database, re-runs safely, reverts and migrates again', async () => {
    expect(
      (
        await database.query<{ server_version: string }[]>(
          'SHOW server_version',
        )
      )[0]?.server_version,
    ).toMatch(/^17\./);
    expect(await database.runMigrations()).toEqual([]);
    await database.undoLastMigration();
    await database.runMigrations();
    expect(await database.getRepository(BatchEntity).count()).toBe(0);
  });
  it('stores one encrypted raw batch for 50 events and projects only the allowlist', async () => {
    const events = Array.from({ length: 50 }, (_, index) => {
      const event = fixture();
      const user = event.user as Record<string, unknown>;
      user.id = index + 1000;
      user.subscription_url = 'synthetic-sensitive-marker';
      user.proxy_settings = { password: 'synthetic-sensitive-marker' };
      return event;
    });
    await inbox.receive(events);
    const batch = await database
      .getRepository(BatchEntity)
      .findOneByOrFail({ id: '1' });
    expect(batch.event_count).toBe(50);
    expect(batch.raw_payload_ciphertext!.toString('utf8')).not.toContain(
      'synthetic-sensitive-marker',
    );
    expect(
      encryption.decrypt({
        ciphertext: batch.raw_payload_ciphertext!,
        iv: batch.raw_payload_iv!,
        authTag: batch.raw_payload_auth_tag!,
        keyVersion: 1,
      }),
    ).toEqual(events);
    await processor().processNext();
    expect(await database.getRepository(BatchEntity).count()).toBe(1);
    expect(await database.getRepository(EventEntity).count()).toBe(50);
    const rows = await database.query<unknown[]>(
      'SELECT row_to_json(e) AS event FROM pasarguard_events e',
    );
    expect(JSON.stringify(rows)).not.toContain('synthetic-sensitive-marker');
    expect(JSON.stringify(rows)).not.toContain('raw_payload');
  });
  it('collapses concurrent duplicate HTTP batches and logical events across deliveries', async () => {
    await Promise.all([inbox.receive(fixture()), inbox.receive(fixture())]);
    expect(await database.getRepository(BatchEntity).count()).toBe(1);
    await processor().processNext();
    await inbox.receive({ ...fixture(), tries: 1, send_at: 1790000100 });
    await processor().processNext();
    const event = await database
      .getRepository(EventEntity)
      .findOneByOrFail({ id: '1' });
    expect(await database.getRepository(EventEntity).count()).toBe(1);
    expect(event.occurrence_count).toBe(2);
    expect(
      await database
        .getRepository(IssueEntity)
        .countBy({ issue_code: 'DUPLICATE_EVENT' }),
    ).toBe(1);
  });
  it('keeps receipt chronology independent and preserves microsecond source timestamps', async () => {
    const receipt = new Date('2026-10-01T00:00:00Z');
    await inbox.receive(
      { ...fixture(), enqueued_at: 1790000000.123456 },
      receipt,
    );
    await processor().processNext();
    const rows = await database.query<{ source: string }[]>(
      "SELECT to_char(source_enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS source FROM pasarguard_events",
    );
    expect(rows[0]?.source).toBe('2026-09-21 14:13:20.123456');
    expect(
      (await database.getRepository(BatchEntity).findOneByOrFail({ id: '1' }))
        .received_at,
    ).toEqual(receipt);
  });
  it('processes malformed and unknown siblings without leaking their values', async () => {
    const malformed = fixture('malformed-event') as unknown as unknown[];
    await inbox.receive([
      ...malformed,
      { ...fixture(), action: 'synthetic-sensitive-marker' },
    ]);
    await processor().processNext();
    expect(await database.getRepository(EventEntity).count()).toBe(1);
    const issues = await database.getRepository(IssueEntity).find();
    expect(issues).toHaveLength(2);
    expect(issues.some((issue) => issue.issue_code === 'UNKNOWN_ACTION')).toBe(
      true,
    );
    expect(JSON.stringify(issues)).not.toContain('synthetic-sensitive-marker');
    expect(
      (await database.getRepository(BatchEntity).findOneByOrFail({ id: '1' }))
        .processing_status,
    ).toBe('NORMALIZED');
  });
  it('stores a non-null unverified Next Plan as review without mapping its object', async () => {
    const event = fixture();
    (event.user as Record<string, unknown>).next_plan = {
      unknown: 'synthetic-marker',
    };
    await inbox.receive(event);
    await processor().processNext();
    const row = await database
      .getRepository(EventEntity)
      .findOneByOrFail({ id: '1' });
    expect(row.event_status).toBe('NEEDS_REVIEW');
    expect(row.next_plan_expire).toBeNull();
    expect(JSON.stringify(row)).not.toContain('synthetic-marker');
  });
  it('two workers cannot normalize one batch concurrently', async () => {
    await inbox.receive(fixture());
    const result = await Promise.all([
      processor().processNext(),
      processor().processNext(),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await database.getRepository(EventEntity).count()).toBe(1);
    expect(
      (await database.getRepository(EventEntity).findOneByOrFail({ id: '1' }))
        .occurrence_count,
    ).toBe(1);
  });
  it('SKIP LOCKED bypasses a locked pending batch without waiting', async () => {
    await inbox.receive(fixture());
    const claim = database.createQueryRunner();
    await claim.connect();
    await claim.startTransaction();
    try {
      await claim.manager
        .getRepository(BatchEntity)
        .createQueryBuilder('batch')
        .setLock('pessimistic_write')
        .getOne();
      expect(await processor().processNext()).toBe(false);
    } finally {
      await claim.rollbackTransaction();
      await claim.release();
    }
    expect(await processor().processNext()).toBe(true);
  });
  it('retry rolls back all child writes before a recovered retry', async () => {
    // PostgreSQL trigger deliberately fails the second child after the first was inserted.
    await database.query(
      "CREATE FUNCTION fp001_fail_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.batch_index = 1 THEN RAISE EXCEPTION 'synthetic-sensitive-marker'; END IF; RETURN NEW; END $$",
    );
    await database.query(
      'CREATE TRIGGER fp001_fail BEFORE INSERT ON pasarguard_events FOR EACH ROW EXECUTE FUNCTION fp001_fail_child()',
    );
    try {
      await inbox.receive(fixture('batch-events'));
      await processor().processNext();
      expect(await database.getRepository(EventEntity).count()).toBe(0);
      const batch = await database
        .getRepository(BatchEntity)
        .findOneByOrFail({ id: '1' });
      expect(batch.processing_status).toBe('FAILED_RETRYABLE');
      expect(batch.processing_attempts).toBe(1);
      expect(batch.last_error_message).not.toContain(
        'synthetic-sensitive-marker',
      );
    } finally {
      await database.query('DROP TRIGGER fp001_fail ON pasarguard_events');
      await database.query('DROP FUNCTION fp001_fail_child()');
    }
    await processor().processNext();
    expect(await database.getRepository(EventEntity).count()).toBe(2);
    expect(
      (await database.getRepository(BatchEntity).findOneByOrFail({ id: '1' }))
        .processing_status,
    ).toBe('NORMALIZED');
  });
  it('attempt exhaustion is permanent and produces a safe issue', async () => {
    await inbox.receive(fixture());
    await database.query(
      "UPDATE pasarguard_webhook_batches SET raw_payload_auth_tag = decode(repeat('00', 16), 'hex')",
    );
    for (let index = 0; index < 3; index++) await processor().processNext();
    const batch = await database
      .getRepository(BatchEntity)
      .findOneByOrFail({ id: '1' });
    expect(batch.processing_status).toBe('FAILED_PERMANENT');
    expect(batch.processing_attempts).toBe(3);
    expect(await processor().processNext()).toBe(false);
    expect(
      await database
        .getRepository(IssueEntity)
        .countBy({ issue_code: 'NORMALIZATION_FAILED' }),
    ).toBe(1);
  });
  it('pending work survives connection/process restart and abandoned transactions roll back', async () => {
    await inbox.receive(fixture());
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager.update(BatchEntity, '1', {
      processing_status: 'NORMALIZING',
    });
    await runner.rollbackTransaction();
    await runner.release();
    await database.destroy();
    database = createDataSource(container.getConnectionUri());
    await database.initialize();
    inbox = new DurableInbox(
      database,
      encryption,
      configFor(container.getConnectionUri()),
    );
    await processor().processNext();
    expect(await database.getRepository(EventEntity).count()).toBe(1);
  });
  it('uses configurable expiry and rejects unknown database states', async () => {
    const config = configFor(container.getConnectionUri(), 3);
    const received = new Date('2026-10-01T00:00:00Z');
    await new DurableInbox(database, encryption, config).receive(
      fixture(),
      received,
    );
    expect(
      (await database.getRepository(BatchEntity).findOneByOrFail({ id: '1' }))
        .raw_payload_expires_at,
    ).toEqual(new Date('2026-10-04T00:00:00Z'));
    await expect(
      database.query(
        "UPDATE pasarguard_webhook_batches SET processing_status = 'INVENTED'",
      ),
    ).rejects.toThrow();
  });
});

it('independent workers process different batches and serialize overlapping event fingerprints', async () => {
  await inbox.receive(fixture());
  await inbox.receive({ ...fixture(), tries: 2 });
  expect(
    await Promise.all([processor().processNext(), processor().processNext()]),
  ).toEqual([true, true]);
  expect(await database.getRepository(EventEntity).count()).toBe(1);
  expect(
    (await database.getRepository(EventEntity).findOneByOrFail({ id: '1' }))
      .occurrence_count,
  ).toBe(2);
});
it('a review-required duplicate cannot remain ready for downstream accounting', async () => {
  await inbox.receive(fixture());
  await processor().processNext();
  const event = fixture();
  (event.user as Record<string, unknown>).next_plan = { unverified: true };
  await inbox.receive(event);
  await processor().processNext();
  expect(
    (await database.getRepository(EventEntity).findOneByOrFail({ id: '1' }))
      .event_status,
  ).toBe('NEEDS_REVIEW');
});
it('delayed duplicate receipt updates first/last seen monotonically', async () => {
  await inbox.receive(fixture(), new Date('2026-10-02T00:00:00Z'));
  await processor().processNext();
  await inbox.receive(
    { ...fixture(), tries: 3 },
    new Date('2026-10-01T00:00:00Z'),
  );
  await processor().processNext();
  const event = await database
    .getRepository(EventEntity)
    .findOneByOrFail({ id: '1' });
  expect(event.first_seen_at).toEqual(new Date('2026-10-01T00:00:00Z'));
  expect(event.last_seen_at).toEqual(new Date('2026-10-02T00:00:00Z'));
});

it('abrupt worker connection loss rolls back its claim and leaves pending work recoverable', async () => {
  await inbox.receive(fixture());
  const crashedSource = createDataSource(container.getConnectionUri());
  await crashedSource.initialize();
  const crashed = crashedSource.createQueryRunner();
  await crashed.connect();
  await crashed.startTransaction();
  const [{ pid } = { pid: 0 }] = await crashed.manager.query<{ pid: number }[]>(
    'SELECT pg_backend_pid() AS pid',
  );
  await crashed.manager.update(BatchEntity, '1', {
    processing_status: 'NORMALIZING',
    processing_attempts: 1,
  });
  await database.query('SELECT pg_terminate_backend($1)', [pid]);
  await expect(crashed.query('SELECT 1')).rejects.toThrow();
  await crashed.release();
  await crashedSource.destroy();
  const batch = await database
    .getRepository(BatchEntity)
    .findOneByOrFail({ id: '1' });
  expect(batch.processing_status).toBe('RECEIVED');
  expect(batch.processing_attempts).toBe(0);
  expect(await processor().processNext()).toBe(true);
  expect(await database.getRepository(EventEntity).count()).toBe(1);
});

it.each(
  projectedTextPaths.flatMap((path) =>
    [0, 1].map((invalidIndex) => [path.join('.'), invalidIndex, path] as const),
  ),
)(
  'FP001-R1: NUL in %s at index %s preserves its valid sibling',
  async (_name, invalidIndex, path) => {
    const invalid = nulBearingEvent(path);
    const valid = fixture();
    const payload = invalidIndex === 0 ? [invalid, valid] : [valid, invalid];
    await inbox.receive(payload);
    expect(await processor().processNext()).toBe(true);
    const batch = await database
      .getRepository(BatchEntity)
      .findOneByOrFail({ id: '1' });
    expect(batch.processing_status).toBe('NORMALIZED');
    expect(batch.processing_attempts).toBe(1);
    expect(batch.last_error_code).toBeNull();
    const events = await database.getRepository(EventEntity).find();
    expect(events).toHaveLength(1);
    expect(events[0]?.batch_index).toBe(1 - invalidIndex);
    expect(events[0]?.username).toBe(
      (valid.user as Record<string, unknown>).username,
    );
    const issues = await database.getRepository(IssueEntity).find();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      batch_id: batch.id,
      batch_index: invalidIndex,
      issue_code: 'INVALID_EVENT',
      issue_message: 'Child event failed the approved field contract',
    });
    expect(JSON.stringify({ events, issues })).not.toContain(
      'synthetic-private',
    );
    expect(
      encryption.decrypt({
        ciphertext: batch.raw_payload_ciphertext!,
        iv: batch.raw_payload_iv!,
        authTag: batch.raw_payload_auth_tag!,
        keyVersion: batch.raw_payload_key_version!,
      }),
    ).toEqual(payload);
    expect(batch.raw_payload_ciphertext!.toString('utf8')).not.toContain(
      'synthetic-private',
    );
    expect(await processor().processNext()).toBe(false);
  },
);
it('FP001-R2: PostgreSQL rounds tiny fractions at the epoch to microseconds without collapsing identities', async () => {
  const cases = [
    [-1e-21, '1970-01-01 00:00:00.000000'],
    [-Number.MIN_VALUE, '1970-01-01 00:00:00.000000'],
    [0, '1970-01-01 00:00:00.000000'],
    [1e-21, '1970-01-01 00:00:00.000000'],
    [Number.MIN_VALUE, '1970-01-01 00:00:00.000000'],
    [-0.125, '1969-12-31 23:59:59.875000'],
    [-0.000001, '1969-12-31 23:59:59.999999'],
    [0.000001, '1970-01-01 00:00:00.000001'],
    [-0.0000005, '1970-01-01 00:00:00.000000'],
    [0.0000005, '1970-01-01 00:00:00.000000'],
    [-0.0000015, '1969-12-31 23:59:59.999998'],
    [0.0000015, '1970-01-01 00:00:00.000002'],
  ] as const;
  await inbox.receive(
    cases.map(([seconds]) => ({
      ...fixture(),
      enqueued_at: seconds,
      send_at: seconds,
    })),
  );
  await processor().processNext();
  const rows = await database.query<
    { enqueued: string; sent: string; semantic_fingerprint: string }[]
  >(
    "SELECT to_char(source_enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS enqueued, to_char(source_send_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS sent, semantic_fingerprint FROM pasarguard_events ORDER BY batch_index",
  );
  expect(rows.map((row) => row.enqueued)).toEqual(
    cases.map(([, expected]) => expected),
  );
  expect(rows.map((row) => row.sent)).toEqual(
    cases.map(([, expected]) => expected),
  );
  expect(new Set(rows.map((row) => row.semantic_fingerprint)).size).toBe(
    cases.length,
  );
  expect(
    (await database.getRepository(BatchEntity).findOneByOrFail({ id: '1' }))
      .processing_status,
  ).toBe('NORMALIZED');
});

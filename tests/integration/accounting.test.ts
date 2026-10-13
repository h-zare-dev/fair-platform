import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  exceptionMessages,
  type AccountingExceptionInput,
  type ShadowChargeInput,
} from '@fair-platform/accounting';
import {
  createAccountingDataSource,
  PostgresAccountingStore,
} from '@fair-platform/accounting/infrastructure';
import {
  BatchProcessor,
  DurableInbox,
  EventEntity,
  PayloadEncryption,
} from '@fair-platform/pasarguard/infrastructure';
import {
  configFor,
  migratedDatabase,
  startPostgres,
} from '../helpers/postgres.js';
import { fixture } from '../helpers/fixtures.js';

let container: StartedPostgreSqlContainer;
let ingestion: Awaited<ReturnType<typeof migratedDatabase>>;
let accounting: ReturnType<typeof createAccountingDataSource>;
let store: PostgresAccountingStore;
let charge: ShadowChargeInput;
const encryption = new PayloadEncryption('11'.repeat(32));
async function count(table: string): Promise<number> {
  const rows = await accounting.query<{ count: string }[]>(
    `SELECT count(*) FROM ${table}`,
  );
  return Number(rows[0]!.count);
}
async function normalize(
  source = 'primary',
  user = 8,
  timestamp = 1790000000,
  retry = 0,
): Promise<string> {
  const event = fixture();
  (event.user as Record<string, unknown>).id = user;
  event.enqueued_at = timestamp;
  event.tries = retry;
  const config = {
    ...configFor(container.getConnectionUri()),
    PASARGUARD_SOURCE_INSTANCE_ID: source,
  };
  await new DurableInbox(ingestion, encryption, config).receive(event);
  await new BatchProcessor(ingestion, encryption, 3).processNext();
  const row = await ingestion.getRepository(EventEntity).findOneByOrFail({
    source_instance_id: source,
    external_user_id: String(user),
    source_enqueued_at: new Date(timestamp * 1000),
  });
  return row.id;
}
beforeAll(async () => {
  container = await startPostgres();
  ingestion = await migratedDatabase(container.getConnectionUri());
  // Upgrade an already populated FP-001 schema rather than testing only an empty schema.
  await normalize();
  accounting = createAccountingDataSource(container.getConnectionUri());
  await accounting.initialize();
  await accounting.runMigrations({ transaction: 'all' });
  store = new PostgresAccountingStore(accounting);
}, 120000);
afterAll(async () => {
  if (accounting?.isInitialized) await accounting.destroy();
  if (ingestion?.isInitialized) await ingestion.destroy();
  if (container) await container.stop();
});
beforeEach(async () => {
  // No trigger bypass/TRUNCATE of the ledger: each test uses a distinct synthetic identity.
  const id = await normalize();
  charge = {
    sourceInstanceId: 'primary',
    operationKey: `operation-${crypto.randomUUID()}`,
    billingAdminId: '77',
    externalUserId: '8',
    amountToman: '9007199254740993',
    occurredAt: '2026-10-01T00:00:00.123456Z',
    reasonCode: 'SYNTHETIC_CHARGE',
    eventIds: [id],
  };
});

describe('PostgreSQL 17 accounting foundation', () => {
  it('upgrades populated FP-001, repeats migrations, refuses unguarded rollback, reverts/reapplies in a disposable DB', async () => {
    expect(
      (
        await accounting.query<{ server_version: string }[]>(
          'SHOW server_version',
        )
      )[0]!.server_version,
    ).toMatch(/^17\./);
    expect(await ingestion.getRepository(EventEntity).count()).toBeGreaterThan(
      0,
    );
    expect(await accounting.runMigrations()).toEqual([]);
    expect(await ingestion.runMigrations()).toEqual([]);
    await expect(accounting.undoLastMigration()).rejects.toThrow(
      'DISPOSABLE_DATABASE_REQUIRED',
    );
    const disposable = createAccountingDataSource(container.getConnectionUri());
    disposable.setOptions({
      extra: { options: '-c fair.accounting_disposable=on' },
    });
    await disposable.initialize();
    try {
      await disposable.undoLastMigration({ transaction: 'all' });
    } finally {
      await disposable.destroy();
    }
    await accounting.runMigrations({ transaction: 'all' });
    expect(await ingestion.getRepository(EventEntity).count()).toBeGreaterThan(
      0,
    );
    const histories = await accounting.query<{ name: string }[]>(
      'SELECT name FROM accounting_migrations',
    );
    expect(histories).toHaveLength(1);
  });
  it('records precise BIGINT, UTC time, caller Billing Admin and immutable links', async () => {
    const result = await store.recordShadowCharge(charge);
    expect(result.outcome).toBe('RECORDED');
    expect(result.record).toMatchObject({
      ...charge,
      postingScope: 'SHADOW',
      entryType: 'CHARGE',
    });
    expect(result.record.recordedAt).toMatch(/Z$/);
    const source = await ingestion
      .getRepository(EventEntity)
      .findOneByOrFail({ id: String(charge.eventIds[0]) });
    expect(result.record.billingAdminId).not.toBe(source.actor_admin_id);
    expect(result.record.billingAdminId).not.toBe(source.billing_admin_id);
    for (const table of [
      'accounting_transactions',
      'accounting_transaction_events',
    ]) {
      await expect(accounting.query(`DELETE FROM ${table}`)).rejects.toThrow(
        'ACCOUNTING_IMMUTABLE',
      );
      await expect(
        accounting.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow('ACCOUNTING_IMMUTABLE');
    }
    await expect(
      accounting.query(
        'UPDATE accounting_transactions SET amount_toman = amount_toman',
      ),
    ).rejects.toThrow('ACCOUNTING_IMMUTABLE');
    await expect(
      accounting.query(
        'UPDATE accounting_transaction_events SET event_id = event_id',
      ),
    ).rejects.toThrow('ACCOUNTING_IMMUTABLE');
    const other = await normalize('primary', 8, 1790000001);
    await expect(
      accounting.query(
        'INSERT INTO accounting_transaction_events VALUES ($1, $2)',
        [result.record.id, other],
      ),
    ).rejects.toThrow('ACCOUNTING_IMMUTABLE');
  });
  it('exact replay returns the original row repeatedly and canonicalizes event sets', async () => {
    charge.eventIds = [
      ...charge.eventIds,
      await normalize('primary', 8, 1790000002),
    ];
    const first = await store.recordShadowCharge(charge);
    const before = await count('accounting_transactions');
    for (let i = 0; i < 5; i++) {
      expect(
        await store.recordShadowCharge({
          ...charge,
          eventIds: [...charge.eventIds].reverse().concat(charge.eventIds),
          amountToman: BigInt(charge.amountToman),
        }),
      ).toEqual({ outcome: 'ALREADY_RECORDED', record: first.record });
    }
    expect(await count('accounting_transactions')).toBe(before);
  });
  it('20 independent PostgreSQL writers commit exactly one transaction and two links', async () => {
    charge.eventIds = [
      ...charge.eventIds,
      await normalize('primary', 8, 1790000003),
    ];
    // Separate pools prove concurrent DB writers, independent of a shared application instance.
    const writers = Array.from({ length: 20 }, () =>
      createAccountingDataSource(container.getConnectionUri()),
    );
    const before = await count('accounting_transactions');
    try {
      await Promise.all(writers.map((writer) => writer.initialize()));
      const results = await Promise.all(
        writers.map((writer) =>
          new PostgresAccountingStore(writer).recordShadowCharge(charge),
        ),
      );
      expect(
        results.filter((result) => result.outcome === 'RECORDED'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.outcome === 'ALREADY_RECORDED'),
      ).toHaveLength(19);
      expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
      expect(
        results.every((result) => result.record.eventIds.length === 2),
      ).toBe(true);
      expect(await count('accounting_transactions')).toBe(before + 1);
      expect(
        await accounting.query(
          'SELECT event_id FROM accounting_transaction_events WHERE transaction_id = $1',
          [results[0]!.record.id],
        ),
      ).toHaveLength(2);
    } finally {
      await Promise.all(
        writers
          .filter((writer) => writer.isInitialized)
          .map((writer) => writer.destroy()),
      );
    }
  }, 30000);
  it.each([
    { amountToman: '10' },
    { billingAdminId: '99' },
    { externalUserId: '99' },
    { eventIds: ['9223372036854775807'] },
    { occurredAt: '2026-10-01T00:00:00.123457Z' },
    { reasonCode: 'OTHER_REASON' },
  ])(
    'conflicting immutable value %j fails without mutation',
    async (changes) => {
      const first = await store.recordShadowCharge(charge);
      const before = await count('accounting_transactions');
      await expect(
        store.recordShadowCharge({ ...charge, ...changes }),
      ).rejects.toMatchObject({
        code: 'FINANCIAL_IDEMPOTENCY_CONFLICT',
        message: 'FINANCIAL_IDEMPOTENCY_CONFLICT',
      });
      expect(await store.recordShadowCharge(charge)).toEqual({
        outcome: 'ALREADY_RECORDED',
        record: first.record,
      });
      expect(await count('accounting_transactions')).toBe(before);
    },
  );
  it('racing conflicting operations produce one winner and one explicit conflict', async () => {
    const before = await count('accounting_transactions');
    const results = await Promise.allSettled([
      store.recordShadowCharge(charge),
      store.recordShadowCharge({ ...charge, amountToman: '10' }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(
      failure?.status === 'rejected' &&
        (failure.reason as { code: string }).code,
    ).toBe('FINANCIAL_IDEMPOTENCY_CONFLICT');
    expect(await count('accounting_transactions')).toBe(before + 1);
  });
  it('equal amounts with distinct operation keys are separate financial effects', async () => {
    const before = await count('accounting_transactions');
    const one = await store.recordShadowCharge(charge);
    const two = await store.recordShadowCharge({
      ...charge,
      operationKey: `${charge.operationKey}-second`,
    });
    expect(one.record.id).not.toBe(two.record.id);
    expect(await count('accounting_transactions')).toBe(before + 2);
  });
  it('same operation key is independent across sources', async () => {
    const other = await normalize('other', 8);
    const one = await store.recordShadowCharge(charge);
    const two = await store.recordShadowCharge({
      ...charge,
      sourceInstanceId: 'other',
      eventIds: [other],
    });
    expect(one.record.id).not.toBe(two.record.id);
  });
  it.each(['source', 'user', 'missing'])(
    'invalid %s event reference rolls back all writes',
    async (kind) => {
      const eventId =
        kind === 'source'
          ? await normalize('other', 8)
          : kind === 'user'
            ? await normalize('primary', 9)
            : '9223372036854775807';
      const before = await count('accounting_transactions');
      const links = await count('accounting_transaction_events');
      await expect(
        store.recordShadowCharge({
          ...charge,
          eventIds: [...charge.eventIds, eventId],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SOURCE_REFERENCE' });
      expect(await count('accounting_transactions')).toBe(before);
      expect(await count('accounting_transaction_events')).toBe(links);
      expect((await store.recordShadowCharge(charge)).outcome).toBe('RECORDED');
    },
  );
  it('failure between insert and linking is sanitized and retry recovers after restart', async () => {
    const before = await count('accounting_transactions');
    const links = await count('accounting_transaction_events');
    await accounting.query(
      "CREATE FUNCTION fp002_fail_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-marker'; END $$",
    );
    await accounting.query(
      'CREATE TRIGGER fp002_fail BEFORE INSERT ON accounting_transaction_events FOR EACH ROW EXECUTE FUNCTION fp002_fail_link()',
    );
    try {
      await expect(store.recordShadowCharge(charge)).rejects.toMatchObject({
        code: 'ACCOUNTING_PERSISTENCE_FAILED',
        message: 'ACCOUNTING_PERSISTENCE_FAILED',
      });
      expect(await count('accounting_transactions')).toBe(before);
      expect(await count('accounting_transaction_events')).toBe(links);
    } finally {
      await accounting.query(
        'DROP TRIGGER fp002_fail ON accounting_transaction_events',
      );
      await accounting.query('DROP FUNCTION fp002_fail_link()');
    }
    await accounting.destroy();
    accounting = createAccountingDataSource(container.getConnectionUri());
    await accounting.initialize();
    store = new PostgresAccountingStore(accounting);
    expect((await store.recordShadowCharge(charge)).outcome).toBe('RECORDED');
    expect((await store.recordShadowCharge(charge)).outcome).toBe(
      'ALREADY_RECORDED',
    );
  });
  it.each(Object.keys(exceptionMessages))(
    'deduplicates %s exceptions and never posts money',
    async (code) => {
      const before = await count('accounting_transactions');
      const input: AccountingExceptionInput = {
        sourceInstanceId: 'primary',
        exceptionKey: `exception-${crypto.randomUUID()}`,
        exceptionCode: code as AccountingExceptionInput['exceptionCode'],
        eventId: charge.eventIds[0]!,
        externalUserId: '8',
        billingAdminId: '77',
      };
      const first = await store.recordAccountingException(input);
      expect(first.outcome).toBe('RECORDED');
      expect(first.record.message).toBe(exceptionMessages[input.exceptionCode]);
      expect(await store.recordAccountingException(input)).toEqual({
        outcome: 'ALREADY_RECORDED',
        record: first.record,
      });
      for (const changes of [
        {
          exceptionCode:
            code === 'PRICING_MISSING'
              ? 'UNEXPECTED_UNLIMITED'
              : 'PRICING_MISSING',
        },
        { eventId: null },
        { externalUserId: '99' },
        { billingAdminId: '99' },
      ]) {
        await expect(
          store.recordAccountingException({
            ...input,
            ...changes,
          } as AccountingExceptionInput),
        ).rejects.toMatchObject({ code: 'ACCOUNTING_EXCEPTION_CONFLICT' });
      }
      expect(await count('accounting_transactions')).toBe(before);
    },
  );
  it('exception records accept absent references and 20 concurrent replays', async () => {
    const input: AccountingExceptionInput = {
      sourceInstanceId: 'primary',
      exceptionKey: `exception-${crypto.randomUUID()}`,
      exceptionCode: 'PREVIOUS_STATE_MISSING',
    };
    const before = await count('accounting_exceptions');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.recordAccountingException(input)),
    );
    expect(
      results.filter((result) => result.outcome === 'RECORDED'),
    ).toHaveLength(1);
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
    expect(await count('accounting_exceptions')).toBe(before + 1);
  });
  it('exception invalid references roll back safely', async () => {
    const before = await count('accounting_exceptions');
    for (const eventId of [
      '9223372036854775807',
      await normalize('other', 8),
      await normalize('primary', 9),
    ]) {
      await expect(
        store.recordAccountingException({
          sourceInstanceId: 'primary',
          exceptionKey: `exception-${crypto.randomUUID()}`,
          exceptionCode: 'PRICING_MISSING',
          eventId,
          externalUserId: '8',
        }),
      ).rejects.toThrow();
    }
    expect(await count('accounting_exceptions')).toBe(before);
  });
  it('SQL rejects zero/negative money, live posting, unsupported entries and linkless commits', async () => {
    for (const [amount, scope, type] of [
      ['0', 'SHADOW', 'CHARGE'],
      ['-1', 'SHADOW', 'CHARGE'],
      ['1', 'LIVE', 'CHARGE'],
      ['1', 'SHADOW', 'REFUND'],
      ['1', 'SHADOW', 'CHARGE'],
    ]) {
      await expect(
        accounting.query(
          `INSERT INTO accounting_transactions (source_instance_id, operation_key, posting_scope, entry_type, billing_admin_id, external_user_id, amount_toman, occurred_at, reason_code) VALUES ('primary', $1, $2, $3, 77, 8, $4, now(), 'SYNTHETIC_CHARGE')`,
          [crypto.randomUUID(), scope, type, amount],
        ),
      ).rejects.toThrow();
    }
  });
  it('preserves signed BIGINT maximum in PostgreSQL', async () => {
    expect(
      (
        await store.recordShadowCharge({
          ...charge,
          amountToman: '9223372036854775807',
        })
      ).record.amountToman,
    ).toBe('9223372036854775807');
  });
});

it('fresh database requires FP-001 first, then supports FP-002 and ordered rollback/reapply', async () => {
  await ingestion.query('CREATE DATABASE fp002_fresh');
  const url = new URL(container.getConnectionUri());
  url.pathname = '/fp002_fresh';
  const freshAccounting = createAccountingDataSource(url.toString());
  await freshAccounting.initialize();
  let freshIngestion: typeof ingestion | undefined;
  try {
    await expect(
      freshAccounting.runMigrations({ transaction: 'all' }),
    ).rejects.toThrow();
    expect(
      await freshAccounting.query(
        "SELECT to_regclass('accounting_transactions') AS name",
      ),
    ).toEqual([{ name: null }]);
    freshIngestion = await migratedDatabase(url.toString());
    await freshAccounting.runMigrations({ transaction: 'all' });
    expect(await freshAccounting.runMigrations()).toEqual([]);
    expect(
      await freshAccounting.query('SELECT * FROM accounting_transactions'),
    ).toEqual([]);
    // The FK dependency intentionally forbids rolling back FP-001 first.
    await expect(freshIngestion.undoLastMigration()).rejects.toThrow();
    const disposable = createAccountingDataSource(url.toString());
    disposable.setOptions({
      extra: { options: '-c fair.accounting_disposable=on' },
    });
    await disposable.initialize();
    try {
      await disposable.undoLastMigration({ transaction: 'all' });
    } finally {
      await disposable.destroy();
    }
    await freshIngestion.undoLastMigration();
    await freshIngestion.runMigrations();
    await freshAccounting.runMigrations();
  } finally {
    await freshAccounting.destroy();
    if (freshIngestion?.isInitialized) await freshIngestion.destroy();
  }
});

it('connection loss during linking rolls back the financial effect and retry recovers', async () => {
  const before = await count('accounting_transactions');
  const links = await count('accounting_transaction_events');
  await accounting.query(`CREATE FUNCTION fp002_crash() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$`);
  await accounting.query(
    'CREATE TRIGGER fp002_crash BEFORE INSERT ON accounting_transaction_events FOR EACH ROW EXECUTE FUNCTION fp002_crash()',
  );
  try {
    await expect(store.recordShadowCharge(charge)).rejects.toMatchObject({
      code: 'ACCOUNTING_PERSISTENCE_FAILED',
    });
    expect(await count('accounting_transactions')).toBe(before);
    expect(await count('accounting_transaction_events')).toBe(links);
  } finally {
    await accounting.query(
      'DROP TRIGGER fp002_crash ON accounting_transaction_events',
    );
    await accounting.query('DROP FUNCTION fp002_crash()');
  }
  expect((await store.recordShadowCharge(charge)).outcome).toBe('RECORDED');
});

it('a failure on the second link rolls back both the first link and ledger row', async () => {
  const second = await normalize('primary', 8, 1790000099);
  const before = await count('accounting_transactions');
  const links = await count('accounting_transaction_events');
  await accounting.query(`CREATE FUNCTION fp002_second_link() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM accounting_transaction_events WHERE transaction_id = NEW.transaction_id)
      THEN RAISE EXCEPTION 'synthetic-private-marker'; END IF; RETURN NEW; END $$`);
  await accounting.query(
    'CREATE TRIGGER fp002_second_link BEFORE INSERT ON accounting_transaction_events FOR EACH ROW EXECUTE FUNCTION fp002_second_link()',
  );
  try {
    await expect(
      store.recordShadowCharge({
        ...charge,
        eventIds: [...charge.eventIds, second],
      }),
    ).rejects.toMatchObject({ message: 'ACCOUNTING_PERSISTENCE_FAILED' });
    expect(await count('accounting_transactions')).toBe(before);
    expect(await count('accounting_transaction_events')).toBe(links);
  } finally {
    await accounting.query(
      'DROP TRIGGER fp002_second_link ON accounting_transaction_events',
    );
    await accounting.query('DROP FUNCTION fp002_second_link()');
  }
});

it('FP-001 normalizes and deduplicates after accounting migrations without creating financial effects', async () => {
  const result = await store.recordShadowCharge(charge);
  const before = await count('accounting_transactions');
  const id = await normalize('primary', 8, 1790000000, 999);
  expect(id).toBe(charge.eventIds[0]);
  expect(await count('accounting_transactions')).toBe(before);
  expect((await store.recordShadowCharge(charge)).record).toEqual(
    result.record,
  );
  expect(
    (await ingestion.getRepository(EventEntity).findOneByOrFail({ id }))
      .occurrence_count,
  ).toBeGreaterThan(1);
});

it('FP-001B normalization never posts money or accounting exceptions for nullable Actor resets/deletes', async () => {
  const before = await count('accounting_transactions');
  const exceptions = await count('accounting_exceptions');
  const reset: Record<string, unknown> = {
    ...fixture(),
    action: 'data_usage_reset',
    by: { id: null, username: 'synthetic-actor' },
  };
  (reset.user as Record<string, unknown>).id = 99123;
  (reset.user as Record<string, unknown>).data_limit_reset_strategy = 'month';
  const inbox = new DurableInbox(
    ingestion,
    encryption,
    configFor(container.getConnectionUri()),
  );
  const payload = [reset, { ...reset, action: 'user_deleted' }];
  await inbox.receive(payload);
  await inbox.receive(payload);
  await new BatchProcessor(ingestion, encryption, 3).processNext();
  const rows = await ingestion
    .getRepository(EventEntity)
    .findBy({ external_user_id: '99123' });
  expect(rows).toHaveLength(2);
  expect(
    rows.every(
      (row) =>
        row.actor_admin_id === null &&
        row.event_status === 'READY_FOR_ACCOUNTING',
    ),
  ).toBe(true);
  expect(await count('accounting_transactions')).toBe(before);
  expect(await count('accounting_exceptions')).toBe(exceptions);
});

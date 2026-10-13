import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  BatchEntity,
  BatchProcessor,
  DurableInbox,
  IssueEntity,
  PayloadEncryption,
  createDataSource,
} from '@fair-platform/pasarguard/infrastructure';
import { main } from '../../scripts/replay/cli.js';
import {
  runReplay,
  snapshot,
  drain,
  type Resources,
} from '../../scripts/replay/runner.js';
import { actorNullSnapshot } from '../../scripts/replay/actor-null.js';
import { ReplayInput } from '../../scripts/replay/input.js';
import {
  configFor,
  migratedDatabase,
  startPostgres,
} from '../helpers/postgres.js';
import { fixture } from '../helpers/fixtures.js';
import { syntheticReplay, syntheticLine } from '../helpers/replay.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function filesFor(lines = [syntheticLine()]) {
  const files = await syntheticReplay(lines);
  cleanups.push(files.cleanup);
  return files;
}

describe('offline replay through original FP-001 PostgreSQL 17 inbox and worker', () => {
  it('reconciles collisions, duplicate batches, semantic overlaps, null/missing actors, warnings and rejected siblings; repeats idempotently', async () => {
    const valid = fixture();
    const warn = fixture();
    (warn.user as Record<string, unknown>).id = 8001;
    (warn.user as Record<string, unknown>).next_plan = {
      synthetic: 'private-marker',
    };
    const nullActor = {
      ...fixture(),
      by: { id: null, username: 'synthetic-private-actor' },
    };
    const absentActor = fixture();
    delete absentActor.by;
    (absentActor.user as Record<string, unknown>).id = 8002;
    const missingActorId = {
      ...fixture(),
      by: { username: 'synthetic-private-actor' },
    };
    const invalid = { ...fixture(), enqueued_at: 'synthetic-private-invalid' };
    const unknown = { ...fixture(), action: 'future_action' };
    const line = syntheticLine(
      [valid, warn, nullActor, absentActor, missingActorId, invalid, unknown],
      '2026-01-15 12:00:00.123456+00:00',
    );
    const overlap = syntheticLine(
      [{ ...valid, tries: 2 }],
      '2026-01-15T13:00:00Z',
    );
    const files = await filesFor([
      line,
      { ...line, received_at: '2026-01-15T11:00:00Z' },
      overlap,
    ]);
    await files.writeManifest({
      ...files.metadata,
      cutoff_utc: '2026-01-16T00:00:00+00:00',
    });
    const report = await runReplay(files.input, files.manifest, true);
    expect(report.status).toBe('PASS');
    expect(report.failures).toEqual([]);
    expect(report.input).toMatchObject({
      legacyGroups: 3,
      children: 15,
      sanitizedDistinctBatches: 2,
      collapsedGroups: 1,
      actorNullOccurrences: 2,
      receiptPrecisionTruncated: 1,
    });
    expect(report.first).toMatchObject({
      batches: 2,
      batchChildren: 8,
      events: 3,
      eventOccurrences: 4,
      rejectedChildren: 4,
      duplicateChildren: 1,
      acceptedWithWarnings: 1,
      batchStatuses: { NORMALIZED: 2 },
    });
    expect(report.first.issues).toEqual({
      DUPLICATE_EVENT: 1,
      INVALID_EVENT: 2,
      INVALID_SOURCE_TIMESTAMP: 1,
      MISSING_REQUIRED_FIELD: 1,
      UNKNOWN_ACTION: 1,
    });
    expect(report.first.actorNull).toMatchObject({
      storedChildOccurrences: 1,
      rejected: 1,
      accepted: 0,
      unresolved: 0,
      issues: { INVALID_EVENT: 1 },
    });
    expect(report.differences).toEqual({
      suppressedChildOccurrences: 7,
      actorNullSuppressedOccurrences: 1,
      unresolvedStoredChildren: 0,
      repeatNewBatches: 0,
      repeatNewEvents: 0,
      repeatNewIssues: 0,
    });
    expect(report.repeat).toEqual(report.first);
    expect(JSON.stringify(report)).not.toContain('private-marker');
    expect(JSON.stringify(report)).not.toContain('synthetic-private');
    expect(JSON.stringify(report)).not.toContain(files.metadata.sha256_gzip);
    expect(JSON.stringify(report)).not.toContain(files.metadata.cutoff_utc);
    expect(report.first.actions).toEqual({ user_updated: 3 });
    expect(report.first.eventStatuses).toEqual({
      NEEDS_REVIEW: 1,
      READY_FOR_ACCOUNTING: 2,
    });
  }, 120000);
  it('is reproducible from two fresh disposable databases and never uses DATABASE_URL from the environment', async () => {
    const files = await filesFor();
    vi.stubEnv(
      'DATABASE_URL',
      'postgres://production-forbidden.invalid/private',
    );
    try {
      const first = await runReplay(files.input, files.manifest);
      expect(await runReplay(files.input, files.manifest)).toEqual(first);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120000);
  it.each([false, true])(
    'executes bounded retry handling and cleans resources for permanent=%s',
    async (permanent) => {
      const files = await filesFor();
      let db: ReturnType<typeof createDataSource> | undefined;
      const stop = vi.fn();
      const factories: Resources = {
        start: async () => {
          const container = await new PostgreSqlContainer(
            'postgres:17-alpine',
          ).start();
          return {
            getConnectionUri: () => container.getConnectionUri(),
            stop: async () => {
              stop();
              await container.stop();
            },
          };
        },
        database: (url) => {
          db = createDataSource(url);
          const migrate = db.runMigrations.bind(db);
          vi.spyOn(db, 'runMigrations').mockImplementation(async (options) => {
            const result = await migrate(options);
            // Synthetic PostgreSQL trigger exercises the actual worker savepoint and retry path.
            await db!.query(
              `CREATE FUNCTION replay_synthetic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${permanent ? 'true' : '(SELECT processing_attempts FROM pasarguard_webhook_batches WHERE id = NEW.batch_id) = 1'} THEN RAISE EXCEPTION 'synthetic-private-marker'; END IF; RETURN NEW; END $$`,
            );
            await db!.query(
              'CREATE TRIGGER replay_fail BEFORE INSERT ON pasarguard_events FOR EACH ROW EXECUTE FUNCTION replay_synthetic_failure()',
            );
            return result;
          });
          return db;
        },
      };
      const report = await runReplay(
        files.input,
        files.manifest,
        false,
        factories,
      );
      expect(report.status).toBe(permanent ? 'FAIL' : 'PASS');
      expect(report.first.processingAttempts).toBe(permanent ? 3 : 2);
      expect(report.first.events).toBe(permanent ? 0 : 1);
      expect(report.first.batchStatuses).toEqual(
        permanent ? { FAILED_PERMANENT: 1 } : { NORMALIZED: 1 },
      );
      if (permanent) {
        expect(report.first.failedBatchReasons).toEqual({
          NORMALIZATION_FAILED: 1,
        });
        expect(report.first.issues).toEqual({ NORMALIZATION_FAILED: 1 });
      }
      expect(db?.isInitialized).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
      expect(JSON.stringify(report)).not.toContain('synthetic-private-marker');
    },
    120000,
  );
  it('redacts a real failed connection to its own stopped disposable database and releases the container handle', async () => {
    const files = await filesFor();
    const stop = vi.fn().mockResolvedValue(undefined);
    let database: ReturnType<typeof createDataSource> | undefined;
    const factories: Resources = {
      start: async () => {
        const container = await new PostgreSqlContainer(
          'postgres:17-alpine',
        ).start();
        const uri = container.getConnectionUri();
        await container.stop();
        return { getConnectionUri: () => uri, stop };
      },
      database: (uri) => {
        database = createDataSource(uri);
        return database;
      },
    };
    await expect(
      runReplay(files.input, files.manifest, false, factories),
    ).rejects.toThrow(/^REPLAY_FAILED$/);
    expect(database?.isInitialized).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  }, 120000);
  it('writes a restrictive aggregate report and compact stdout summary through the CLI', async () => {
    const files = await filesFor();
    const out = join(files.directory, 'report.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await main([
        '--input',
        files.input,
        '--manifest',
        files.manifest,
        '--out',
        out,
        '--offline-disposable',
        '--repeat',
      ]),
    ).toBe(0);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const report: unknown = JSON.parse(await readFile(out, 'utf8'));
    expect(report).toMatchObject({ schema_version: 1, status: 'PASS' });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0])).toContain('Replay PASS');
    expect(String(log.mock.calls[0])).not.toContain(files.directory);
  }, 120000);
});

describe('P2: set-based Actor-null PostgreSQL aggregation', () => {
  it('keeps snapshot query count constant across more batches, semantic duplicates and sanitized collisions', async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      syntheticLine([
        {
          ...fixture(),
          by: { id: null, username: 'synthetic-private-actor' },
          tries: index,
        },
        { ...fixture(), tries: index },
      ]),
    );
    const firstFiles = await filesFor(lines.slice(0, 2));
    const allFiles = await filesFor([...lines, lines[0]!, lines[15]!]);
    const load = async (files: Awaited<ReturnType<typeof filesFor>>) => {
      const input = await ReplayInput.open(files.input, files.manifest);
      try {
        return await input.preflight();
      } finally {
        await input.close();
      }
    };
    const small = await load(firstFiles);
    const large = await load(allFiles);
    const container = await startPostgres();
    let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
    try {
      database = await migratedDatabase(container.getConnectionUri());
      const encryption = new PayloadEncryption('11'.repeat(32));
      const inbox = new DurableInbox(
        database,
        encryption,
        configFor(container.getConnectionUri()),
      );
      const processor = new BatchProcessor(database, encryption, 3);
      for (const line of lines.slice(0, 2)) await inbox.receive(line.payload);
      await drain(processor, 2, 3);
      const queries = vi
        .spyOn(database.logger, 'logQuery')
        .mockImplementation(() => undefined);
      const first = await snapshot(database, small);
      const count = queries.mock.calls.length;
      expect(count).toBeGreaterThan(0);
      expect(first.actorNull).toEqual({
        storedChildOccurrences: 2,
        rejected: 2,
        accepted: 0,
        unresolved: 0,
        issues: { INVALID_EVENT: 2 },
      });
      for (const line of [...lines, lines[0]!, lines[15]!])
        await inbox.receive(line.payload);
      await drain(processor, 40, 3);
      queries.mockClear();
      const final = await snapshot(database, large);
      expect(queries.mock.calls.length).toBe(count);
      expect(final.actorNull).toEqual({
        storedChildOccurrences: 40,
        rejected: 40,
        accepted: 0,
        unresolved: 0,
        issues: { INVALID_EVENT: 40 },
      });
      expect(large.actorNull).toBe(42);
      expect(final.batches).toBe(40);
      expect(final.events).toBe(1);
      expect(final.duplicateChildren).toBe(39);
      expect(final.eventOccurrences).toBe(40);
      queries.mockClear();
      expect(await snapshot(database, large)).toEqual(final);
      expect(queries.mock.calls.length).toBe(count);
    } finally {
      try {
        if (database?.isInitialized) await database.destroy();
      } finally {
        await container.stop();
      }
    }
  }, 120000);
  it('classifies accepted, rejected and unresolved targets without multiplying duplicate markers or warning issues', async () => {
    const container = await startPostgres();
    let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
    try {
      database = await migratedDatabase(container.getConnectionUri());
      const encryption = new PayloadEncryption('11'.repeat(32));
      const inbox = new DurableInbox(
        database,
        encryption,
        configFor(container.getConnectionUri()),
      );
      const processor = new BatchProcessor(database, encryption, 3);
      const rejected = {
        ...fixture(),
        by: { id: null, username: 'synthetic' },
      };
      const accepted = fixture();
      const warned = fixture();
      (warned.user as Record<string, unknown>).id = 9001;
      (warned.user as Record<string, unknown>).next_plan = { synthetic: true };
      await inbox.receive([rejected, accepted, warned]);
      await inbox.receive([
        rejected,
        { ...accepted, tries: 1 },
        { ...warned, tries: 1 },
      ]);
      await drain(processor, 2, 3);
      await inbox.receive([{ ...rejected, tries: 3 }]);
      const batches = await database
        .getRepository(BatchEntity)
        .find({ select: { id: true }, order: { id: 'ASC' } });
      await database.getRepository(IssueEntity).insert([
        {
          batch_id: batches[1]!.id,
          batch_index: 1,
          issue_code: 'DUPLICATE_EVENT',
          issue_message: 'Synthetic repeated marker',
        },
        {
          batch_id: batches[1]!.id,
          batch_index: 1,
          issue_code: 'INVALID_EVENT',
          issue_message: 'Synthetic accepted warning',
        },
        {
          batch_id: batches[2]!.id,
          batch_index: null,
          issue_code: 'NORMALIZATION_FAILED',
          issue_message: 'Synthetic batch-only issue',
        },
      ]);
      // Include accepted positions as synthetic unexpected outcomes: the reporting adapter
      // must classify them accurately, without making Actor-null valid in normalization.
      const result = await actorNullSnapshot(database, [
        { batch_id: batches[0]!.id, indices: [0, 1, 2] },
        { batch_id: batches[1]!.id, indices: [0, 1, 2] },
        { batch_id: batches[2]!.id, indices: [0] },
      ]);
      expect(result).toEqual({
        storedChildOccurrences: 7,
        accepted: 4,
        rejected: 2,
        unresolved: 1,
        issues: { DUPLICATE_EVENT: 3, INVALID_EVENT: 5 },
      });
    } finally {
      try {
        if (database?.isInitialized) await database.destroy();
      } finally {
        await container.stop();
      }
    }
  }, 120000);
});

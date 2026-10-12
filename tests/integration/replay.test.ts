import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createDataSource } from '@fair-platform/pasarguard/infrastructure';
import { main } from '../../scripts/replay/cli.js';
import { runReplay, type Resources } from '../../scripts/replay/runner.js';
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
    const line = syntheticLine([
      valid,
      warn,
      nullActor,
      absentActor,
      missingActorId,
      invalid,
      unknown,
    ]);
    const overlap = syntheticLine(
      [{ ...valid, tries: 2 }],
      '2026-01-15T13:00:00Z',
    );
    const files = await filesFor([
      line,
      { ...line, received_at: '2026-01-15T11:00:00Z' },
      overlap,
    ]);
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

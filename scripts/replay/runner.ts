import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  BatchEntity,
  BatchProcessor,
  DurableInbox,
  EventEntity,
  IssueEntity,
  PayloadEncryption,
  createDataSource,
  readConfig,
} from '@fair-platform/pasarguard/infrastructure';
import { fail, safeCode } from './errors.js';
import { ReplayInput, type Preflight } from './input.js';

export type ReplayDatabase = ReturnType<typeof createDataSource>;
export interface ReplayContainer {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
}
export interface Resources {
  start(): Promise<ReplayContainer>;
  database(url: string): ReplayDatabase;
}
const resources: Resources = {
  start: () => new PostgreSqlContainer('postgres:17-alpine').start(),
  database: createDataSource,
};
export interface Snapshot {
  batches: number;
  batchChildren: number;
  events: number;
  eventOccurrences: number;
  rejectedChildren: number;
  acceptedWithWarnings: number;
  duplicateChildren: number;
  issues: Record<string, number>;
  batchStatuses: Record<string, number>;
  eventStatuses: Record<string, number>;
  actions: Record<string, number>;
  actorNull: {
    storedChildOccurrences: number;
    rejected: number;
    accepted: number;
    unresolved: number;
    issues: Record<string, number>;
  };
  processingAttempts: number;
  failedBatchReasons: Record<string, number>;
}
const number = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) fail('REPLAY_FAILED');
  return result;
};
async function grouped(
  database: ReplayDatabase,
  entity: typeof EventEntity | typeof BatchEntity | typeof IssueEntity,
  column: string,
): Promise<Record<string, number>> {
  const rows = await database
    .createQueryBuilder()
    .select(`row.${column}`, 'key')
    .addSelect('COUNT(*)', 'count')
    .from(entity, 'row')
    .groupBy(`row.${column}`)
    .orderBy(`row.${column}`)
    .getRawMany<{ key: string; count: string }>();
  return Object.fromEntries(rows.map((row) => [row.key, number(row.count)]));
}

/** Query only aggregate/small receipt metadata; no usernames, payloads or normalized user rows leave PostgreSQL. */
export async function snapshot(
  database: ReplayDatabase,
  input: Preflight,
): Promise<Snapshot> {
  const batches = await database.getRepository(BatchEntity).find({
    select: {
      id: true,
      payload_hash: true,
      event_count: true,
      processing_status: true,
      processing_attempts: true,
      last_error_code: true,
    },
  });
  if (
    batches.length !== input.batches.size ||
    batches.some(
      (batch) =>
        input.batches.get(batch.payload_hash)?.children !== batch.event_count,
    )
  )
    fail('REPLAY_FAILED');
  const issues = await grouped(database, IssueEntity, 'issue_code');
  const events = await database.getRepository(EventEntity).count();
  const occurrences = await database
    .getRepository(EventEntity)
    .createQueryBuilder('e')
    .select('COALESCE(SUM(e.occurrence_count), 0)', 'count')
    .getRawOne<{ count: string }>();
  // Distinct child keys prevent warnings and multiple issue codes from being mistaken for rejected children.
  const rejected = await database
    .getRepository(IssueEntity)
    .createQueryBuilder('i')
    .select('COUNT(DISTINCT (i.batch_id, i.batch_index))', 'count')
    .leftJoin(
      'pasarguard_events',
      'e',
      'e.batch_id = i.batch_id AND e.batch_index = i.batch_index',
    )
    .where('i.batch_index IS NOT NULL AND e.id IS NULL')
    .andWhere(
      "NOT EXISTS (SELECT 1 FROM pasarguard_ingestion_issues d WHERE d.batch_id = i.batch_id AND d.batch_index = i.batch_index AND d.issue_code = 'DUPLICATE_EVENT')",
    )
    .getRawOne<{ count: string }>();
  const warned = await database
    .getRepository(IssueEntity)
    .createQueryBuilder('i')
    .select('COUNT(DISTINCT (i.batch_id, i.batch_index))', 'count')
    .where('i.batch_index IS NOT NULL AND i.issue_code != :duplicate', {
      duplicate: 'DUPLICATE_EVENT',
    })
    .andWhere(
      "(EXISTS (SELECT 1 FROM pasarguard_events e WHERE e.batch_id = i.batch_id AND e.batch_index = i.batch_index) OR EXISTS (SELECT 1 FROM pasarguard_ingestion_issues d WHERE d.batch_id = i.batch_id AND d.batch_index = i.batch_index AND d.issue_code = 'DUPLICATE_EVENT'))",
    )
    .getRawOne<{ count: string }>();
  const actor: Snapshot['actorNull'] = {
    storedChildOccurrences: 0,
    rejected: 0,
    accepted: 0,
    unresolved: 0,
    issues: {},
  };
  const reasons: Record<string, number> = {};
  for (const batch of batches) {
    if (batch.processing_status === 'FAILED_PERMANENT') {
      const reason =
        batch.last_error_code === 'NORMALIZATION_FAILED'
          ? 'NORMALIZATION_FAILED'
          : 'UNSPECIFIED_FAILURE';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    const indices = input.batches.get(batch.payload_hash)!.actorIndices;
    if (!indices.length) continue;
    actor.storedChildOccurrences += indices.length;
    const childIssues = await database
      .getRepository(IssueEntity)
      .createQueryBuilder('i')
      .select(['i.batch_index', 'i.issue_code'])
      .where('i.batch_id = :id AND i.batch_index IN (:...indices)', {
        id: batch.id,
        indices,
      })
      .getMany();
    const accepted = await database
      .getRepository(EventEntity)
      .createQueryBuilder('e')
      .select('e.batch_index')
      .where('e.batch_id = :id AND e.batch_index IN (:...indices)', {
        id: batch.id,
        indices,
      })
      .getMany();
    for (const index of indices) {
      const codes = childIssues
        .filter((issue) => issue.batch_index === index)
        .map((issue) => issue.issue_code);
      for (const code of codes)
        actor.issues[code] = (actor.issues[code] ?? 0) + 1;
      if (
        accepted.some((event) => event.batch_index === index) ||
        codes.includes('DUPLICATE_EVENT')
      )
        actor.accepted++;
      else if (codes.length) actor.rejected++;
      else actor.unresolved++;
    }
  }
  return {
    batches: batches.length,
    batchChildren: batches.reduce((sum, b) => sum + b.event_count, 0),
    events,
    eventOccurrences: number(occurrences?.count ?? 0),
    rejectedChildren: number(rejected?.count ?? 0),
    acceptedWithWarnings: number(warned?.count ?? 0),
    duplicateChildren: issues.DUPLICATE_EVENT ?? 0,
    issues,
    batchStatuses: await grouped(database, BatchEntity, 'processing_status'),
    eventStatuses: await grouped(database, EventEntity, 'event_status'),
    actions: await grouped(database, EventEntity, 'action'),
    actorNull: actor,
    processingAttempts: batches.reduce(
      (sum, b) => sum + b.processing_attempts,
      0,
    ),
    failedBatchReasons: reasons,
  };
}
export async function drain(
  processor: Pick<BatchProcessor, 'processNext'>,
  batches: number,
  attempts: number,
): Promise<number> {
  const bound = batches * attempts;
  let processed = 0;
  while (await processor.processNext()) {
    if (++processed > bound) fail('REPLAY_FAILED');
  }
  return processed;
}
export interface Report {
  schema_version: 1;
  status: 'PASS' | 'FAIL';
  failures: string[];
  provenance: {
    source: string;
    window_days: number;
    manifest_format: 'v1' | 'legacy-unversioned';
  };
  input: {
    legacyGroups: number;
    legacyRows: number;
    children: number;
    actions: Record<string, number>;
    repetitionMismatches: number;
    actorNullOccurrences: number;
    sanitizedDistinctBatches: number;
    collapsedGroups: number;
    receiptPrecisionTruncated: number;
  };
  first: Snapshot;
  repeat: Snapshot | null;
  differences: {
    suppressedChildOccurrences: number;
    actorNullSuppressedOccurrences: number;
    unresolvedStoredChildren: number;
    repeatNewBatches: number | null;
    repeatNewEvents: number | null;
    repeatNewIssues: number | null;
  };
  limitations: string[];
}
export function reportFor(
  input: ReplayInput,
  preflight: Preflight,
  first: Snapshot,
  repeat: Snapshot | null,
): Report {
  const failures: string[] = [];
  const unresolved =
    first.batchChildren -
    first.events -
    first.duplicateChildren -
    first.rejectedChildren;
  if (
    Object.keys(first.batchStatuses).some((status) => status !== 'NORMALIZED')
  )
    failures.push('BATCH_PROCESSING_FAILED');
  if (
    unresolved !== 0 ||
    first.eventOccurrences !== first.events + first.duplicateChildren
  )
    failures.push('CHILD_RECONCILIATION_FAILED');
  if (first.actorNull.accepted || first.actorNull.unresolved)
    failures.push('ACTOR_NULL_OUTCOME_DISCREPANCY');
  const totalIssues = (s: Snapshot) =>
    Object.values(s.issues).reduce((sum, count) => sum + count, 0);
  if (
    repeat &&
    (repeat.batches !== first.batches ||
      repeat.events !== first.events ||
      repeat.eventOccurrences !== first.eventOccurrences ||
      JSON.stringify(repeat.batchStatuses) !==
        JSON.stringify(first.batchStatuses))
  )
    failures.push('REPEAT_IDEMPOTENCY_FAILED');
  return {
    schema_version: 1,
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    provenance: {
      source: input.manifest.source,
      window_days: input.manifest.window_days,
      manifest_format:
        input.manifest.manifest_version === 1 ? 'v1' : 'legacy-unversioned',
    },
    input: {
      legacyGroups: preflight.groups,
      legacyRows: preflight.legacyRows,
      children: preflight.children,
      actions: Object.fromEntries(Object.entries(preflight.actions).sort()),
      repetitionMismatches: preflight.repetitionMismatches,
      actorNullOccurrences: preflight.actorNull,
      sanitizedDistinctBatches: preflight.batches.size,
      collapsedGroups: preflight.groups - preflight.batches.size,
      receiptPrecisionTruncated: preflight.receiptPrecisionTruncated,
    },
    first,
    repeat,
    differences: {
      suppressedChildOccurrences: preflight.children - first.batchChildren,
      actorNullSuppressedOccurrences:
        preflight.actorNull - first.actorNull.storedChildOccurrences,
      unresolvedStoredChildren: unresolved,
      repeatNewBatches: repeat ? repeat.batches - first.batches : null,
      repeatNewEvents: repeat ? repeat.events - first.events : null,
      repeatNewIssues: repeat ? totalIssues(repeat) - totalIssues(first) : null,
    },
    limitations: [
      'Receipt time is MIN(legacy created_at), not verified original HTTP arrival; JavaScript Date truncates receipt sub-millisecond precision.',
      'Input is already sanitized JSONB evidence, not byte-identical HTTP; collapsed groups are measured by canonical hashes, not proven physical deliveries.',
      'Invalid children and accepted children with warnings are distinct; issue counters can overlap.',
      'Actor-null outcomes cover stored distinct batches; suppressed input occurrences are separately counted.',
      'No accounting, pricing, correlation, delivery or live webhook compatibility is verified; FP-002 is not called.',
      'Windows are nested; cutoff and checksum are validated privately and omitted from reports.',
    ],
  };
}

/** Injectable resource factories are for synthetic failure tests; the CLI exposes no URL or persistent target. */
export async function runReplay(
  inputPath: string,
  manifestPath: string,
  repeat = false,
  factories: Resources = resources,
): Promise<Report> {
  let input: ReplayInput | undefined;
  let container: ReplayContainer | undefined;
  let database: ReplayDatabase | undefined;
  try {
    input = await ReplayInput.open(inputPath, manifestPath);
    const preflight = await input.preflight();
    container = await factories.start();
    const config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      PASARGUARD_SOURCE_INSTANCE_ID: 'offline-historical-replay',
      WEBHOOK_NORMALIZATION_MAX_ATTEMPTS: '3',
    });
    database = factories.database(config.DATABASE_URL);
    // Bound connection acquisition and each SQL call as well as the number of worker claims.
    // These options apply only to the disposable harness-owned pool.
    database.setOptions({
      extra: {
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
        query_timeout: 35000,
      },
    });
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
    const encryption = new PayloadEncryption(config.APP_ENCRYPTION_KEY);
    const inbox = new DurableInbox(database, encryption, config);
    const processor = new BatchProcessor(
      database,
      encryption,
      config.WEBHOOK_NORMALIZATION_MAX_ATTEMPTS,
    );
    const pass = async () => {
      for await (const line of input!.records())
        await inbox.receive(line.payload, line.receivedAt);
      await drain(
        processor,
        preflight.batches.size,
        config.WEBHOOK_NORMALIZATION_MAX_ATTEMPTS,
      );
      return snapshot(database!, preflight);
    };
    const first = await pass();
    const second = repeat ? await pass() : null;
    return reportFor(input, preflight, first, second);
  } catch (error) {
    return fail(safeCode(error));
  } finally {
    // Independent cleanup attempts: one close failure must not prevent the remaining resource releases.
    let failed = false;
    try {
      if (database?.isInitialized) await database.destroy();
    } catch {
      failed = true;
    }
    try {
      if (container) await container.stop();
    } catch {
      failed = true;
    }
    try {
      await input?.close();
    } catch {
      failed = true;
    }
    if (failed) fail('CLEANUP_FAILED');
  }
}

import type {
  DataSource,
  EntityManager,
  ObjectLiteral,
  SelectQueryBuilder,
} from 'typeorm';
import {
  BatchEntity,
  EventEntity,
  IssueEntity,
} from '@fair-platform/pasarguard/infrastructure';
import {
  nextCursor,
  type OperationFilter,
  type OperationsReader,
} from '../application/operations.js';
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const issueMessages: Record<string, string> = {
  INVALID_EVENT: 'Invalid event structure',
  INVALID_SOURCE_TIMESTAMP: 'Invalid source timestamp',
  UNKNOWN_ACTION: 'Unsupported event action',
  MISSING_REQUIRED_FIELD: 'Required event field is missing',
  DUPLICATE_EVENT: 'Logical event already exists',
  NORMALIZATION_FAILED: 'Batch normalization failed',
};
export class PostgresOwnerOperations implements OperationsReader {
  constructor(private readonly db: DataSource) {}
  private scope<T extends ObjectLiteral>(
    q: SelectQueryBuilder<T>,
    f: OperationFilter,
    column: string,
    sourceColumn: string,
  ) {
    q.where(
      `${column} >= CAST(:start AS timestamptz) AND ${column} < CAST(:end AS timestamptz)`,
      { start: f.start, end: f.end },
    );
    if (f.source) q.andWhere(`${sourceColumn}=:source`, { source: f.source });
    return q;
  }
  private batchEvents(m: EntityManager, f: OperationFilter) {
    // Count and page events by the historical receipt window of their inbox
    // batch. `e.created_at` is the *new server's* normalization time, which
    // would incorrectly put an entire 30-day replay into today's totals.
    const events = this.scope(
      m
        .getRepository(EventEntity)
        .createQueryBuilder('e')
        .innerJoin('pasarguard_webhook_batches', 'b', 'b.id=e.batch_id'),
      f,
      'b.received_at',
      'b.source_instance_id',
    );
    if (f.actions)
      events.andWhere('e.action = ANY(CAST(:actions AS text[]))', {
        actions: f.actions,
      });
    return events;
  }
  async summary(f: OperationFilter) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const batch = () =>
        this.scope(
          m.getRepository(BatchEntity).createQueryBuilder('b'),
          f,
          'b.received_at',
          'b.source_instance_id',
        );
      const count = async (q: SelectQueryBuilder<ObjectLiteral>) =>
        (
          await q
            .select('COUNT(*)::text', 'count')
            .getRawOne<{ count: string }>()
        )?.count ?? '0';
      const receivedBatches = await count(batch());
      const normalizedEvents = await count(this.batchEvents(m, f));
      const recent = m
        .getRepository(EventEntity)
        .createQueryBuilder('e')
        .where("e.created_at >= now() - interval '24 hours'")
        .andWhere('e.created_at < now()');
      if (f.source)
        recent.andWhere('e.source_instance_id=:source', { source: f.source });
      if (f.actions)
        recent.andWhere('e.action = ANY(CAST(:actions AS text[]))', {
          actions: f.actions,
        });
      // Independent throughput metric: processing *now*, not event history.
      const processedLast24h = await count(recent);
      const openIngestionIssues = await count(
        this.issueQuery(m, f).andWhere('i.resolved_at IS NULL'),
      );
      const failedRetryable = await count(
        batch().andWhere("b.processing_status='FAILED_RETRYABLE'"),
      );
      const failedPermanent = await count(
        batch().andWhere("b.processing_status='FAILED_PERMANENT'"),
      );
      const pendingBatches = await count(
        batch().andWhere("b.processing_status IN ('RECEIVED','NORMALIZING')"),
      );
      const processedBatches = await count(
        batch().andWhere("b.processing_status='NORMALIZED'"),
      );
      return {
        pendingBatches,
        processedBatches,
        processedLast24h,
        start: f.start,
        end: f.end,
        source: f.source,
        receivedBatches,
        normalizedEvents,
        openIngestionIssues,
        failedBatches: (
          BigInt(failedRetryable) + BigInt(failedPermanent)
        ).toString(),
        failedRetryable,
        failedPermanent,
        mode: 'STAGING / AUTHENTICATED SHADOW TEST / NO LIVE BILLING',
      };
    });
  }
  private issueQuery(m: EntityManager, f: OperationFilter) {
    return this.scope(
      m
        .getRepository(IssueEntity)
        .createQueryBuilder('i')
        .innerJoin('pasarguard_webhook_batches', 'b', 'b.id=i.batch_id'),
      f,
      'b.received_at',
      'b.source_instance_id',
    );
  }
  async events(f: OperationFilter) {
    const q = this.batchEvents(this.db.manager, f);
    if (f.cursor)
      q.andWhere(
        '(b.received_at,e.id)<(CAST(:time AS timestamptz),CAST(:id AS bigint))',
        f.cursor,
      );
    const rows = await q
      .select('e.id::text', 'id')
      .addSelect('e.action', 'action')
      .addSelect('e.external_user_id::text', 'externalUserId')
      .addSelect('e.username', 'accountName')
      .addSelect('e.billing_admin_username', 'ownerName')
      .addSelect('e.actor_admin_username', 'actorName')
      .addSelect('e.actor_admin_id::text', 'actorId')
      .addSelect('e.user_status', 'userStatus')
      .addSelect('e.data_limit_bytes::text', 'dataLimitBytes')
      .addSelect(timestamp('b.received_at'), 'receivedAt')
      .addSelect(timestamp('e.source_enqueued_at'), 'sourceTimestamp')
      .addSelect(timestamp('e.first_seen_at'), 'firstSeenAt')
      .addSelect('e.event_status', 'eventStatus')
      .addSelect('e.billing_admin_id::text', 'billingAdminId')
      .addSelect(
        "CASE WHEN e.actor_admin_id IS NOT NULL THEN 'KNOWN' WHEN e.actor_admin_username IS NOT NULL THEN 'UNIDENTIFIED' ELSE 'ABSENT' END",
        'actorStatus',
      )
      .addSelect('e.occurrence_count', 'occurrenceCount')
      .orderBy('b.received_at', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .limit(f.limit + 1)
      .getRawMany<{
        id: string;
        action: string;
        externalUserId: string;
        accountName: string;
        ownerName: string;
        actorName: string | null;
        actorId: string | null;
        userStatus: string;
        dataLimitBytes: string;
        receivedAt: string;
        sourceTimestamp: string;
        firstSeenAt: string;
        eventStatus: string;
        billingAdminId: string;
        actorStatus: string;
        occurrenceCount: number;
      }>();
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      start: f.start,
      end: f.end,
      rows: page,
      nextCursor:
        rows.length > f.limit && last
          ? nextCursor(f, 'events', last.receivedAt, last.id)
          : null,
    };
  }
  async issues(f: OperationFilter) {
    const q = this.issueQuery(this.db.manager, f);
    if (f.cursor)
      q.andWhere(
        '(b.received_at,i.id)<(CAST(:time AS timestamptz),CAST(:id AS bigint))',
        f.cursor,
      );
    const rows = await q
      .select('i.id::text', 'id')
      .addSelect('i.issue_code', 'code')
      .addSelect('i.batch_index', 'batchIndex')
      .addSelect(timestamp('b.received_at'), 'receivedAt')
      .addSelect(timestamp('i.created_at'), 'createdAt')
      .addSelect('i.resolved_at IS NOT NULL', 'resolved')
      .orderBy('b.received_at', 'DESC')
      .addOrderBy('i.id', 'DESC')
      .limit(f.limit + 1)
      .getRawMany<{
        id: string;
        code: string;
        batchIndex: number | null;
        receivedAt: string;
        createdAt: string;
        resolved: boolean;
      }>();
    const page = rows.slice(0, f.limit).map((r) => ({
      ...r,
      code: Object.hasOwn(issueMessages, r.code) ? r.code : 'INGESTION_ISSUE',
      message: Object.hasOwn(issueMessages, r.code)
        ? issueMessages[r.code]!
        : 'Event requires review',
    }));
    const last = page.at(-1);
    return {
      start: f.start,
      end: f.end,
      rows: page,
      nextCursor:
        rows.length > f.limit && last
          ? nextCursor(f, 'issues', last.receivedAt, last.id)
          : null,
    };
  }
  async ready(): Promise<void> {
    await Promise.all([
      this.db
        .getRepository(EventEntity)
        .createQueryBuilder('e')
        .select('e.id')
        .limit(1)
        .getRawMany(),
      this.db
        .getRepository(BatchEntity)
        .createQueryBuilder('b')
        .select('b.id')
        .limit(1)
        .getRawMany(),
      this.db
        .getRepository(IssueEntity)
        .createQueryBuilder('i')
        .select('i.id')
        .limit(1)
        .getRawMany(),
      this.db.query('SELECT token_hash FROM fair_owner_sessions LIMIT 1'),
      this.db.query('SELECT id FROM fair_owner_login_budget LIMIT 1'),
      this.db.query('SELECT password_hash FROM fair_owner WHERE FALSE'),
      this.db.query('SELECT id FROM fair_pricing_rule_versions LIMIT 1'),
    ]);
  }
}

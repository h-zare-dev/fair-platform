import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  OpeningBaselineDirectory,
  OpeningUser,
} from './opening-baseline-directory.js';

const SOURCE = 'primary';
const PAGE_SIZE = 50;

type Run = {
  id: string;
  status: string;
  phase: 'SCAN' | 'VERIFY';
  next_offset: number;
  source_total: number | null;
  verified_total: number | null;
  lease_token: string | null;
};

export class OpeningBaselineBusy extends Error {
  constructor() {
    super('OPENING_BASELINE_ALREADY_RUNNING');
  }
}

export class PostgresOpeningBaseline {
  constructor(
    private readonly db: DataSource,
    private readonly directory: OpeningBaselineDirectory,
  ) {}

  async start(): Promise<{ id: string; status: string }> {
    try {
      const rows: { id: string; status: string }[] = await this.db.query(
        `INSERT INTO fair_opening_baseline_runs(source_instance_id,status)
         VALUES ($1,'PENDING') RETURNING id::text,status`,
        [SOURCE],
      );
      return rows[0]!;
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new OpeningBaselineBusy();
      throw error;
    }
  }

  async summary(): Promise<{
    mode: 'OPENING_BASELINE_SHADOW';
    postingScope: 'NONE';
    financialCutoverReady: false;
    sourceInstanceId: string;
    run: null | {
      id: string;
      status: string;
      phase: string;
      offset: number;
      sourceTotal: number | null;
      verifiedTotal: number | null;
      firstPassUsers: number;
      stable: number;
      changed: number;
      added: number;
      missing: number;
      unverified: number;
      unknownAdmin: number;
      unknownVolume: number;
      unknownExactDuration: number;
      failureCode: string | null;
      startedAt: string;
      finishedAt: string | null;
    };
  }> {
    type Row = {
      id: string;
      status: string;
      phase: string;
      next_offset: number;
      source_total: number | null;
      verified_total: number | null;
      failure_code: string | null;
      started_at: Date;
      finished_at: Date | null;
      users: string;
      stable: string;
      changed: string;
      added: string;
      missing: string;
      unverified: string;
      unknown_admin: string;
      unknown_volume: string;
      unknown_duration: string;
    };
    const rows: Row[] = await this.db.query(
      `
      SELECT r.*, count(u.external_user_id) FILTER
        (WHERE u.verification_status<>'ADDED')::text AS users,
        count(*) FILTER (WHERE u.verification_status='STABLE')::text AS stable,
        count(*) FILTER (WHERE u.verification_status='CHANGED')::text AS changed,
        count(*) FILTER (WHERE u.verification_status='ADDED')::text AS added,
        count(*) FILTER (WHERE u.verification_status='MISSING')::text AS missing,
        count(*) FILTER (WHERE u.verification_status='UNVERIFIED')::text AS unverified,
        count(*) FILTER (WHERE u.external_user_id IS NOT NULL AND u.billing_admin_id IS NULL)::text AS unknown_admin,
        count(*) FILTER (WHERE u.external_user_id IS NOT NULL AND
          (u.data_limit_bytes IS NULL OR u.data_limit_bytes=0))::text AS unknown_volume,
        count(*) FILTER (WHERE u.external_user_id IS NOT NULL AND
          (u.user_status <> 'on_hold' OR u.on_hold_duration_seconds IS NULL OR
           u.on_hold_duration_seconds=0))::text AS unknown_duration
      FROM fair_opening_baseline_runs r
      LEFT JOIN fair_opening_baseline_users u ON u.run_id=r.id
      WHERE r.id=(SELECT max(id) FROM fair_opening_baseline_runs WHERE source_instance_id=$1)
      GROUP BY r.id`,
      [SOURCE],
    );
    const r = rows[0];
    return {
      mode: 'OPENING_BASELINE_SHADOW',
      postingScope: 'NONE',
      financialCutoverReady: false,
      sourceInstanceId: SOURCE,
      run: r
        ? {
            id: r.id,
            status: r.status,
            phase: r.phase,
            offset: r.next_offset,
            sourceTotal: r.source_total,
            verifiedTotal: r.verified_total,
            firstPassUsers: Number(r.users),
            stable: Number(r.stable),
            changed: Number(r.changed),
            added: Number(r.added),
            missing: Number(r.missing),
            unverified: Number(r.unverified),
            unknownAdmin: Number(r.unknown_admin),
            unknownVolume: Number(r.unknown_volume),
            // Active expiry is NOT proof of original package duration. This count is
            // deliberately conservative; no derived 30/60/90-day package is invented.
            unknownExactDuration: Number(r.unknown_duration),
            failureCode: r.failure_code,
            startedAt: r.started_at.toISOString(),
            finishedAt: r.finished_at?.toISOString() ?? null,
          }
        : null,
    };
  }

  private async claim(): Promise<Run | null> {
    const token = randomUUID();
    // TypeORM's raw PostgreSQL UPDATE query returns [rows, affectedCount],
    // not the rows directly. A data-modifying CTE with a final SELECT returns
    // a genuine row array, so the lease cannot be silently misinterpreted.
    const rows: Run[] = await this.db.query(
      `WITH claimed AS (
        UPDATE fair_opening_baseline_runs SET
          status=CASE WHEN status='PENDING' THEN 'SCANNING' ELSE status END,
          lease_token=$1,lease_until=clock_timestamp()+interval '45 seconds'
        WHERE id=(SELECT id FROM fair_opening_baseline_runs
          WHERE source_instance_id=$2 AND status IN ('PENDING','SCANNING','VERIFYING')
            AND (lease_until IS NULL OR lease_until<clock_timestamp())
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text,status,phase,next_offset,source_total,verified_total,lease_token
      ) SELECT * FROM claimed`,
      [token, SOURCE],
    );
    return rows[0] ?? null;
  }

  /** One bounded upstream page; database state and cursor commit atomically. */
  async runNext(): Promise<boolean> {
    const run = await this.claim();
    if (!run) return false;
    try {
      const page = await this.directory.listIds(run.next_offset, PAGE_SIZE);
      const expectedTotal =
        run.phase === 'SCAN' ? run.source_total : run.verified_total;
      if (expectedTotal !== null && expectedTotal !== page.total)
        throw new Error('OPENING_BASELINE_TOTAL_CHANGED');
      if (
        page.total < run.next_offset ||
        page.ids.length !== Math.min(PAGE_SIZE, page.total - run.next_offset)
      )
        throw new Error('OPENING_BASELINE_PAGE_INCOMPLETE');
      const users = page.ids.length
        ? await this.directory.details(page.ids)
        : [];
      if (
        users.length !== page.ids.length ||
        new Set(users.map((u) => u.externalUserId)).size !== page.ids.length ||
        users.some((u) => !page.ids.includes(u.externalUserId))
      )
        throw new Error('OPENING_BASELINE_DETAIL_INCOMPLETE');

      await this.db.transaction(async (manager) => {
        const checked: Run[] = await manager.query(
          `
          SELECT id::text,status,phase,next_offset,source_total,verified_total,lease_token
          FROM fair_opening_baseline_runs WHERE id=$1 FOR UPDATE`,
          [run.id],
        );
        if (
          checked[0]?.lease_token !== run.lease_token ||
          checked[0]?.next_offset !== run.next_offset ||
          checked[0]?.phase !== run.phase
        )
          throw new Error('OPENING_BASELINE_LEASE_LOST');
        const previous: { max: string | null }[] = await manager.query(
          `
          SELECT max(external_user_id)::text AS max FROM fair_opening_baseline_users
          WHERE run_id=$1 ${
            run.phase === 'VERIFY'
              ? "AND verification_status<>'UNVERIFIED'"
              : ''
          }`,
          [run.id],
        );
        if (
          page.ids.length &&
          previous[0]?.max &&
          BigInt(page.ids[0]!) <= BigInt(previous[0].max)
        )
          throw new Error('OPENING_BASELINE_ORDER_CHANGED');

        for (const user of users) {
          if (run.phase === 'SCAN')
            await this.insertFirst(manager, run.id, user);
          else await this.verify(manager, run.id, user);
        }
        const finished = run.next_offset + page.ids.length === page.total;
        if (run.phase === 'SCAN') {
          await manager.query(
            `UPDATE fair_opening_baseline_runs SET
            source_total=$2,phase=CASE WHEN $3 THEN 'VERIFY' ELSE 'SCAN' END,
            status=CASE WHEN $3 THEN 'VERIFYING' ELSE 'SCANNING' END,
            next_offset=CASE WHEN $3 THEN 0 ELSE $4 END,
            lease_token=NULL,lease_until=NULL WHERE id=$1`,
            [run.id, page.total, finished, run.next_offset + page.ids.length],
          );
        } else {
          if (finished)
            await manager.query(
              `UPDATE fair_opening_baseline_users
            SET verification_status='MISSING'
            WHERE run_id=$1 AND verification_status='UNVERIFIED'`,
              [run.id],
            );
          await manager.query(
            `UPDATE fair_opening_baseline_runs SET
            verified_total=$2,next_offset=$3,
            status=CASE WHEN $4 THEN 'COMPLETE' ELSE 'VERIFYING' END,
            finished_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
            lease_token=NULL,lease_until=NULL WHERE id=$1`,
            [run.id, page.total, run.next_offset + page.ids.length, finished],
          );
        }
      });
      return true;
    } catch (error) {
      const code =
        error instanceof Error &&
        /^OPENING_BASELINE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'OPENING_BASELINE_SOURCE_UNAVAILABLE';
      await this.db.query(
        `UPDATE fair_opening_baseline_runs
        SET status='FAILED',failure_code=$3,finished_at=clock_timestamp(),
          lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND lease_token=$2 AND status IN ('SCANNING','VERIFYING')`,
        [run.id, run.lease_token, code],
      );
      return true;
    }
  }

  private async insertFirst(
    manager: EntityManager,
    runId: string,
    user: OpeningUser,
  ) {
    await manager.query(
      `INSERT INTO fair_opening_baseline_users
      (run_id,external_user_id,billing_admin_id,user_status,data_limit_bytes,
       used_traffic_bytes,expires_at,on_hold_duration_seconds,reset_strategy,
       source_created_at,source_edited_at,fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        runId,
        user.externalUserId,
        user.billingAdminId,
        user.status,
        user.dataLimitBytes,
        user.usedTrafficBytes,
        user.expiresAt,
        user.onHoldDurationSeconds,
        user.resetStrategy,
        user.sourceCreatedAt,
        user.sourceEditedAt,
        user.fingerprint,
      ],
    );
  }

  private async verify(
    manager: EntityManager,
    runId: string,
    user: OpeningUser,
  ) {
    const rows: { fingerprint: string; verification_status: string }[] =
      await manager.query(
        `
      SELECT fingerprint,verification_status FROM fair_opening_baseline_users
      WHERE run_id=$1 AND external_user_id=$2`,
        [runId, user.externalUserId],
      );
    if (!rows.length) {
      await this.insertFirst(manager, runId, user);
      await manager.query(
        `UPDATE fair_opening_baseline_users
        SET verification_status='ADDED',verified_fingerprint=$3
        WHERE run_id=$1 AND external_user_id=$2`,
        [runId, user.externalUserId, user.fingerprint],
      );
    } else {
      if (rows[0]!.verification_status !== 'UNVERIFIED')
        throw new Error('OPENING_BASELINE_DUPLICATE_VERIFICATION');
      await manager.query(
        `UPDATE fair_opening_baseline_users
        SET verification_status=$3,verified_fingerprint=$4
        WHERE run_id=$1 AND external_user_id=$2`,
        [
          runId,
          user.externalUserId,
          rows[0]!.fingerprint === user.fingerprint ? 'STABLE' : 'CHANGED',
          user.fingerprint,
        ],
      );
    }
  }
}

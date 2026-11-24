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
      nonMaterialChanged: number;
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
      non_material_changed: string;
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
        count(*) FILTER (WHERE u.verification_status='STABLE' AND
          u.verified_fingerprint IS DISTINCT FROM u.fingerprint)::text AS non_material_changed,
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
            nonMaterialChanged: Number(r.non_material_changed),
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
          lease_token=$1,lease_until=clock_timestamp()+interval '5 minutes'
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
      if (run.phase === 'SCAN') await this.scanPage(run);
      else await this.verifyPage(run);
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

  private assertDetails(ids: string[], users: OpeningUser[]): void {
    if (
      new Set(users.map((u) => u.externalUserId)).size !== users.length ||
      users.some((u) => !ids.includes(u.externalUserId))
    )
      throw new Error('OPENING_BASELINE_DETAIL_INCOMPLETE');
  }

  private async assertLease(manager: EntityManager, run: Run): Promise<void> {
    const checked: Run[] = await manager.query(
      `SELECT id::text,status,phase,next_offset,source_total,verified_total,lease_token
       FROM fair_opening_baseline_runs WHERE id=$1 FOR UPDATE`,
      [run.id],
    );
    if (
      checked[0]?.lease_token !== run.lease_token ||
      checked[0]?.next_offset !== run.next_offset ||
      checked[0]?.phase !== run.phase
    )
      throw new Error('OPENING_BASELINE_LEASE_LOST');
  }

  private async scanPage(run: Run): Promise<void> {
    // The count is observational. New users at the sorted tail, or deleted
    // users before the offset, must not make this non-posting run fail.
    const previous: { max: string | null }[] = await this.db.query(
      `SELECT max(external_user_id)::text AS max FROM fair_opening_baseline_users
       WHERE run_id=$1`,
      [run.id],
    );
    const anchor = previous[0]?.max ? BigInt(previous[0].max) : null;
    let offset = run.next_offset;
    let page: Awaited<ReturnType<OpeningBaselineDirectory['listIds']>> | null =
      null;
    // Offset cursors move when users are removed before the cursor. Find the
    // first surviving ID after the persisted anchor, so those deletions do
    // not silently skip unrelated existing accounts.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (anchor !== null && offset > 0) {
        const before = await this.directory.listIds(offset - 1, 1);
        if (!before.ids.length || BigInt(before.ids[0]!) > anchor)
          offset = await this.findSuccessorOffset(anchor, before.total);
      }
      const candidate = await this.directory.listIds(offset, PAGE_SIZE);
      const before =
        anchor !== null && offset > 0
          ? await this.directory.listIds(offset - 1, 1)
          : null;
      if (
        anchor === null ||
        ((!candidate.ids.length || BigInt(candidate.ids[0]!) > anchor) &&
          (!before?.ids.length || BigInt(before.ids[0]!) <= anchor))
      ) {
        page = candidate;
        break;
      }
      offset = await this.findSuccessorOffset(anchor, candidate.total);
    }
    if (!page) throw new Error('OPENING_BASELINE_ORDER_CHANGED');
    const users = page.ids.length ? await this.directory.details(page.ids) : [];
    this.assertDetails(page.ids, users);
    // A missing detail can be a real deletion between list and detail reads.
    // Re-read missing IDs once so a short, inconsistent source response does
    // not discard an otherwise available opening account.
    const absent = page.ids.filter(
      (id) => !users.some((user) => user.externalUserId === id),
    );
    const recovered = absent.length ? await this.directory.details(absent) : [];
    this.assertDetails(absent, recovered);
    const observed = [...users, ...recovered].sort((a, b) =>
      BigInt(a.externalUserId) < BigInt(b.externalUserId) ? -1 : 1,
    );
    const finished =
      page.ids.length < PAGE_SIZE || offset + page.ids.length >= page.total;
    await this.db.transaction(async (manager) => {
      await this.assertLease(manager, run);
      const committed: { max: string | null }[] = await manager.query(
        `SELECT max(external_user_id)::text AS max FROM fair_opening_baseline_users
         WHERE run_id=$1`,
        [run.id],
      );
      if (committed[0]?.max !== (previous[0]?.max ?? null))
        throw new Error('OPENING_BASELINE_LEASE_LOST');
      if (
        page.ids.length &&
        committed[0]?.max &&
        BigInt(page.ids[0]!) <= BigInt(committed[0].max)
      )
        throw new Error('OPENING_BASELINE_ORDER_CHANGED');
      for (const user of observed)
        await this.insertFirst(manager, run.id, user);
      await manager.query(
        `UPDATE fair_opening_baseline_runs SET
          source_total=COALESCE(source_total,$2),
          phase=CASE WHEN $3 THEN 'VERIFY' ELSE 'SCAN' END,
          status=CASE WHEN $3 THEN 'VERIFYING' ELSE 'SCANNING' END,
          next_offset=CASE WHEN $3 THEN 0 ELSE $4 END,
          lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [run.id, page.total, finished, offset + page.ids.length],
      );
    });
  }

  private async findSuccessorOffset(
    anchor: bigint,
    observedTotal: number,
  ): Promise<number> {
    let low = 0;
    let high = observedTotal;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const probe = await this.directory.listIds(mid, 1);
      if (probe.ids.length && BigInt(probe.ids[0]!) <= anchor) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private async verifyPage(run: Run): Promise<void> {
    // Verify the *persisted* first-pass roster, not unstable live offsets.
    // A new PasarGuard user is outside this cohort and cannot silently become
    // a pre-existing opening account or an invented Create charge.
    const roster: { id: string }[] = await this.db.query(
      `SELECT external_user_id::text AS id FROM fair_opening_baseline_users
       WHERE run_id=$1 AND verification_status='UNVERIFIED'
       ORDER BY external_user_id LIMIT $2`,
      [run.id, PAGE_SIZE + 1],
    );
    const ids = roster.slice(0, PAGE_SIZE).map((row) => row.id);
    const first = ids.length ? await this.directory.details(ids) : [];
    this.assertDetails(ids, first);
    const absent = ids.filter(
      (id) => !first.some((user) => user.externalUserId === id),
    );
    const recovered = absent.length ? await this.directory.details(absent) : [];
    this.assertDetails(absent, recovered);
    const users = [...first, ...recovered];
    const missing = ids.filter(
      (id) => !users.some((user) => user.externalUserId === id),
    );
    // A one-record source count is enough to report net count drift. It is
    // not used for pagination, identity inference or financial readiness.
    const currentCount = await this.directory.listIds(0, 1);
    const finished = roster.length <= PAGE_SIZE;
    await this.db.transaction(async (manager) => {
      await this.assertLease(manager, run);
      const checked: { id: string }[] = await manager.query(
        `SELECT external_user_id::text AS id FROM fair_opening_baseline_users
         WHERE run_id=$1 AND verification_status='UNVERIFIED'
         ORDER BY external_user_id LIMIT $2`,
        [run.id, PAGE_SIZE + 1],
      );
      if (
        checked.length !== roster.length ||
        checked.some((row, i) => row.id !== roster[i]?.id)
      )
        throw new Error('OPENING_BASELINE_LEASE_LOST');
      for (const user of users) await this.verify(manager, run.id, user);
      for (const id of missing)
        await manager.query(
          `UPDATE fair_opening_baseline_users SET verification_status='MISSING'
           WHERE run_id=$1 AND external_user_id=$2 AND verification_status='UNVERIFIED'`,
          [run.id, id],
        );
      await manager.query(
        `UPDATE fair_opening_baseline_runs SET
         verified_total=$2,next_offset=$3,
         status=CASE WHEN $4 THEN 'COMPLETE' ELSE 'VERIFYING' END,
         finished_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
         lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [run.id, currentCount.total, run.next_offset + ids.length, finished],
      );
    });
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
    const rows: {
      fingerprint: string;
      verification_status: string;
      billing_admin_id: string | null;
      user_status: string;
      data_limit_bytes: string | null;
      expires_at: Date | null;
      on_hold_duration_seconds: string | null;
      reset_strategy: string | null;
      source_created_at: Date;
    }[] = await manager.query(
      `
      SELECT fingerprint,verification_status,billing_admin_id::text,user_status,
        data_limit_bytes::text,expires_at,on_hold_duration_seconds::text,
        reset_strategy,source_created_at FROM fair_opening_baseline_users
      WHERE run_id=$1 AND external_user_id=$2`,
      [runId, user.externalUserId],
    );
    if (!rows.length) throw new Error('OPENING_BASELINE_UNKNOWN_ROSTER_USER');
    const old = rows[0]!;
    if (old.verification_status !== 'UNVERIFIED')
      throw new Error('OPENING_BASELINE_DUPLICATE_VERIFICATION');
    // Usage bytes and edit_at are volatile observations, not a change in
    // package shape, admin ownership or source lifecycle state.
    const materialChange =
      old.billing_admin_id !== user.billingAdminId ||
      old.user_status !== user.status ||
      old.data_limit_bytes !== user.dataLimitBytes ||
      old.expires_at?.toISOString() !== (user.expiresAt ?? undefined) ||
      old.on_hold_duration_seconds !==
        (user.onHoldDurationSeconds == null
          ? null
          : String(user.onHoldDurationSeconds)) ||
      old.reset_strategy !== user.resetStrategy ||
      old.source_created_at.toISOString() !==
        new Date(user.sourceCreatedAt).toISOString();
    await manager.query(
      `UPDATE fair_opening_baseline_users
       SET verification_status=$3,verified_fingerprint=$4
       WHERE run_id=$1 AND external_user_id=$2`,
      [
        runId,
        user.externalUserId,
        materialChange ? 'CHANGED' : 'STABLE',
        user.fingerprint,
      ],
    );
  }
}

import { fail } from './errors.js';
import { LIMITS } from './input.js';
import type { ReplayDatabase, Snapshot } from './runner.js';

export interface ActorBatch {
  batch_id: string;
  indices: number[];
}

/** One set-based query, bounded by preflight limits; original FP-001 schema remains unchanged. */
export async function actorNullSnapshot(
  database: ReplayDatabase,
  batches: ActorBatch[],
): Promise<Snapshot['actorNull']> {
  const total = batches.reduce((sum, batch) => sum + batch.indices.length, 0);
  if (batches.length > LIMITS.groups || total > LIMITS.children)
    fail('REPLAY_FAILED');
  if (!total)
    return {
      storedChildOccurrences: 0,
      accepted: 0,
      rejected: 0,
      unresolved: 0,
      issues: {},
    };
  // PostgreSQL JSONB expansion avoids one parameter per child. MATERIALIZED CTEs
  // share the event/issue matches across classifications and issue-code totals.
  // All joins are set-based; no correlated batch-by-batch event scans are needed.
  const rows = await database.query<
    {
      accepted: string;
      rejected: string;
      unresolved: string;
      issues: Record<string, number>;
    }[]
  >(
    `
    WITH targets AS MATERIALIZED (
      SELECT b.batch_id, idx.value::integer AS batch_index
      FROM jsonb_to_recordset($1::jsonb) AS b(batch_id bigint, indices jsonb)
      CROSS JOIN LATERAL jsonb_array_elements_text(b.indices) AS idx(value)
    ), matching_events AS MATERIALIZED (
      SELECT DISTINCT e.batch_id, e.batch_index
      FROM pasarguard_events e JOIN targets t USING (batch_id, batch_index)
    ), matching_issues AS MATERIALIZED (
      SELECT i.batch_id, i.batch_index, i.issue_code
      FROM pasarguard_ingestion_issues i JOIN targets t USING (batch_id, batch_index)
    ), issue_children AS (
      SELECT batch_id, batch_index, COUNT(*) AS issue_count,
             bool_or(issue_code = 'DUPLICATE_EVENT') AS duplicate
      FROM matching_issues GROUP BY batch_id, batch_index
    ), outcomes AS (
      SELECT e.batch_id IS NOT NULL OR COALESCE(i.duplicate, false) AS accepted,
             COALESCE(i.issue_count, 0) AS issue_count
      FROM targets t
      LEFT JOIN matching_events e USING (batch_id, batch_index)
      LEFT JOIN issue_children i USING (batch_id, batch_index)
    )
    SELECT COUNT(*) FILTER (WHERE accepted) AS accepted,
           COUNT(*) FILTER (WHERE NOT accepted AND issue_count > 0) AS rejected,
           COUNT(*) FILTER (WHERE NOT accepted AND issue_count = 0) AS unresolved,
           (SELECT COALESCE(jsonb_object_agg(issue_code, n), '{}'::jsonb)
            FROM (SELECT issue_code, COUNT(*) AS n FROM matching_issues GROUP BY issue_code) codes) AS issues
    FROM outcomes
  `,
    [JSON.stringify(batches)],
  );
  const row = rows[0];
  if (!row) fail('REPLAY_FAILED');
  const counts = [row.accepted, row.rejected, row.unresolved].map(Number);
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    counts.reduce((sum, count) => sum + count, 0) !== total ||
    Object.values(row.issues).some(
      (count) => !Number.isSafeInteger(count) || count < 0,
    )
  )
    fail('REPLAY_FAILED');
  return {
    storedChildOccurrences: total,
    accepted: counts[0]!,
    rejected: counts[1]!,
    unresolved: counts[2]!,
    issues: Object.fromEntries(Object.entries(row.issues).sort()),
  };
}

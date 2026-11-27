# P2-02 — PostgreSQL 17 query-plan evidence

Fresh disposable PostgreSQL 17 experiment on 2026-10-14: 120,000 batches and 120,000 normalized events, eight synthetic source IDs, two-minute time steps (~167 days), one-day half-open window. Actual production statement timeout (5 seconds) applies during EXPLAIN; only bulk fixture loading uses 60 seconds. No planner settings force index use. Full [EXPLAIN ANALYZE/BUFFERS JSON](evidence/FP-003B-query-plans.json) is synthetic and checked in.

| Query | All-source before (ms / plan) | All-source after (ms / plan) | Source-filtered before → after (ms) |
| --- | --- | --- | --- |
| Batch receipt count | 12.648 / sequential scan | 0.249 / global-time index-only scan | 0.147 → 0.241 |
| Event creation count | 34.978 / sequential scan | 0.393 / global-time index-only scan | 0.128 → 0.261 |
| Source-time events DESC time/id, LIMIT 26 | 2.839 / index scan plus sort | 0.073 / global-time index-only scan, no sort | 0.083 → 0.075 |

The final measured experiment applies the explicit TypeORM `OwnerGlobalTimeIndexes1791100000000` migration to the same populated database after undoing only this migration for baseline measurement. It adds exactly `(received_at)` on batches, `(created_at)` on events, and `(source_enqueued_at DESC,id DESC)` on events. Existing source-leading indexes remain. Source-filtered event pagination continues using `owner_events_source_time`; the count planner chooses global-time index scans with source filtering after migration. All six final plans avoid sequential scans for this selective one-day experiment. Source-count timing differences at these submillisecond scales are not evidence of a significant regression.

This justifies three narrowly scoped indexes, not speculative covering/status/issue indexes. Global issue-created ordering already has an index. No operational/business table definitions or historical migrations were rewritten. Migration hashes/names are included in release-check; operators must approve the updated exact proof before activation.

Limits: timings depend on local hardware, cache, visibility maps and this synthetic distribution. API event projections fetch more columns than the narrow ordering experiment, so index-only behavior is not promised for full rows; the ordering/range index still applies. Broad 30-day ranges, heavily skewed sources, additional failed-status/issue joins and larger retained histories may legitimately use sequential/bitmap scans. This is no production scalability or real-staging performance claim. The regression checks selective range plans, result-bearing execution and migration up/down on real PostgreSQL; it imposes no fragile wall-clock threshold.

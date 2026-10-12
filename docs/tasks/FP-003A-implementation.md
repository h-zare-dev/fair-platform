# FP-003A implementation plan and operator guide

The approved [specification](FP-003A-historical-replay.md) governs this offline verification tool. The runner uses synthetic fixtures in development and CI. The Owner runs private historical files separately after independent Review and QA.

## Implementation plan

1. Validate versioned-v1 and legacy-unversioned manifests, original gzip SHA-256, UTC receipt dates, JSONL structure, occurrence counters and complete source action counts before starting any database.
2. Stream bounded decompression while retaining only distinct canonical hashes and Actor-null child indices. Preserve payload arrays, numeric timestamps and child order. Measure groups collapsed to identical sanitized payloads without reconstructing removed legacy fields.
3. Start PostgreSQL 17 with Testcontainers, use a random disposable encryption key, and run the original FP-001 migration. Invoke the existing `DurableInbox` once per input line and drain `BatchProcessor` with its bounded attempts.
4. Reconcile persisted batch/event statuses and issues into an aggregate report, distinguishing rejected children, accepted warnings, semantic duplicates and suppressed batch occurrences. Optionally import again into the same disposable database.
5. Verify synthetic input, adversarial boundaries, retries, failure cleanup and repeatability; run all mandatory repository checks. Keep one Draft PR to `development` for independent Review and QA.

## Local synthetic demonstration

Requirements: repository-supported Node.js and pnpm, local Docker and the `postgres:17-alpine` image (Testcontainers may pull it). No production secrets are needed.

```sh
pnpm install --frozen-lockfile
pnpm exec tsx scripts/replay/synthetic.ts
```

The generator prints a new directory under the operating system temporary directory and writes only the committed synthetic FP-001 fixture. Substitute that generated directory for `/tmp/fair-synthetic-replay-EXAMPLE`:

```sh
pnpm replay:historical \
  --offline-disposable \
  --input /tmp/fair-synthetic-replay-EXAMPLE/synthetic.jsonl.gz \
  --manifest /tmp/fair-synthetic-replay-EXAMPLE/synthetic.manifest.json \
  --out /tmp/fair-synthetic-replay-EXAMPLE/report.json \
  --repeat
```

For execution after a full build, the equivalent direct command is:

```sh
node scripts/replay/dist/cli.js \
  --offline-disposable \
  --input /tmp/fair-synthetic-replay-EXAMPLE/synthetic.jsonl.gz \
  --manifest /tmp/fair-synthetic-replay-EXAMPLE/synthetic.manifest.json \
  --out /tmp/fair-synthetic-replay-EXAMPLE/report.json \
  --repeat
```

Both explicit input paths and `--offline-disposable` are required. Unknown flags and arbitrary database URLs are rejected. The tool never reads runtime `DATABASE_URL` or production encryption configuration. `--repeat` is optional. Existing output files are never overwritten. Always use an explicit `--out` for a convenient operator-selected location; when omitted, the tool creates `report.json` in a new private `fair-replay-report-*` temporary directory. Input, manifest and output destinations must be outside Git worktrees, with symlinks resolved. Report files use mode `0600`; generated directories use mode `0700`. Temporary reports are local private artifacts and must not be uploaded or committed.

The tool refuses verbose `DEBUG`/`TESTCONTAINERS_DEBUG` settings. It prints a compact aggregate outcome and fixed error codes, never parser/driver diagnostics, file paths, payloads or per-user information. A PASS exits zero; integrity, technical, processing, cleanup and invariant failures exit nonzero. Expected FP-001 child validation issues alone do not make operational replay fail.

## Input and resource bounds

- Manifest: 64 KiB; duplicate JSON keys and unknown manifest fields rejected.
- Original gzip bytes: 128 MiB; decompressed bytes: 512 MiB.
- JSONL line: 1 MiB; maximum 1,000 children per batch.
- Maximum 100,000 candidate groups and 1,000,000 child occurrences; maximum JSON nesting depth 64.
- Manifest fields are not coerced. Blank lines, invalid UTF-8/gzip/JSON, invalid UTC dates, non-object children and malformed action labels are rejected before container creation.

Every stream pass rechecks the original compressed-byte hash and file metadata, and uses the same read-only file descriptor. No private input copy is created. Do not edit an input file during replay. Memory scales with bounded line size plus distinct batch hashes and Actor-null indices, rather than all input payloads. Processing uses the original worker's three-attempt limit and an independent maximum-call bound, with a 10-second connection-acquisition timeout, 30-second server statement timeout and 35-second client query timeout for the disposable pool. Database connections and containers are released in independent `finally` cleanup attempts, including migration/processing failures.

## Report interpretation and limits

`schema_version: 1` identifies the aggregate report contract. `input` describes candidate legacy groups, rows, child occurrences, source actions, canonical sanitized hash count, collapsed groups, declared repetition mismatches and Actor-null occurrences. `first` and optional `repeat` describe actual stored batches, child counts, events, semantic occurrences, statuses, actions and issues. `differences` records suppressed children, suppressed Actor-null occurrences, unresolved stored children and changes on repeat import.

`collapsedGroups` means multiple candidate groups have the same canonical sanitized payload. The sanitized file cannot establish whether identical lines came from different original JSONB contents or duplicate export records; removed fields are unavailable. It does not measure physical HTTP deliveries. No actual hashes are emitted.

`rejectedChildren` counts distinct stored child positions with issues and no persisted event or semantic duplicate marker. `acceptedWithWarnings` counts accepted positions with non-duplicate issues. An `INVALID_EVENT` issue can accompany an accepted, review-required Next Plan event; issue totals are not mutually exclusive rejection totals. Actor-null outcomes are measured from actual persisted events/issues at those stored child indices; batch-suppressed input occurrences are reported separately. The runner does not fix null/missing Actor identities or substitute Billing Admin.

`received_at` is the legacy group's minimum storage timestamp. JavaScript Date truncates sub-millisecond receipt precision; `receiptPrecisionTruncated` counts affected input lines. Numeric event source timestamps and array order remain unchanged. Worker processing order follows the existing inbox semantics, independently of event chronology.

Correctly declared nonzero repetition mismatches are analytical findings. Failed or hanging batches, child reconciliation failures, unexpected Actor-null acceptance, and repeat stored-entity changes are operational failures. Repeat issue-count changes are recorded separately rather than assumed equal.

The private cutoff, input checksum, manifest notes, paths, identities and payload values are omitted. Counts and action maps remain private analysis results when derived from the Owner's data. Seven-/thirty-day windows validate their own manifests; this tool neither generates exports nor verifies cutoff equality across separate runs. It does not establish pricing, accounting, correlation, financial balances, physical deliveries, or live upstream wire/auth compatibility. No FP-001/FP-002 source, migration, production configuration or live service is modified.

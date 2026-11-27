# Fair Platform — FP-003A Historical Replay Harness

> **Historical approved task spec (2026-10-12).** FP-003A has since been merged to `development` (PR #31); the Owner's private 1/7/30-day offline acceptance was completed. The original future-tense steps below document the approved implementation contract, **not current status**. See [`ROADMAP.md`](../ROADMAP.md) for the next FP-003B milestone. FP-001B (PR #32) superseded the original Actor-object/null-ID rejection expectation. Do not publish private real-data evidence here.

**Status:** Owner-approved implementation specification (public-repository-safe edition; 2026-10-12). Do not merge or deploy without separate explicit approval.

**Privacy:** This is a PUBLIC repository. Do not commit the Owner's real replay data, manifests, private aggregate statistics, exact acquisition cutoff, or source-file checksum; only synthetic fixtures may be committed.

**Repository:** `h-zare-dev/fair-platform`  
**Parent feature:** FP-003 Owner-only Operational Monitoring Dashboard  
**Task boundary:** FP-003A = offline historical-replay verification; FP-003B = operational read APIs, authentication and dashboard (designed separately).  
**Baseline:** FP-001/FP-002 released on `main` (observed head `9b7f316b7388dec2a4775da68accf8f5b40c7ab9` at preparation time; recheck before starting).

## 1. Goal

Run **sanitized historical Pasarjew webhook batches** through the existing Fair FP-001 durable inbox and real normalization worker **without any connection to live Pasarguard/Pasarjew, using a disposable PostgreSQL 17 environment**, then produce a reproducible, privacy-safe discrepancy report. Begin with one fixed day; later repeat on seven and thirty nested days. No billing, production connection, Pasarguard delivery, Pasarjew modification, or release deployment.

This feature is a verification harness, not a financial calculator. FP-002 stays SHADOW-only and is **not called**.

## 2. Fixed one-day input and provenance

Files exist **only on the Owner's laptop**, outside any repo/worktree:

- `~/Work/fair-platform-replay-private/pasarjew-replay-1d.jsonl.gz`
- `~/Work/fair-platform-replay-private/pasarjew-replay-1d.manifest.json`

The relative path must be supplied explicitly to the runner; never infer/commit/copy these files into tracked workspace content. The optional HMAC identity key stays on the Pasarjew server and is never requested by the runner.

Owner-held real manifest metadata is intentionally **not published in this public repository**. The private manifest contains the actual values for `source`, `window_days`, `cutoff_utc`, all counters, `action_counts`, and `sha256_gzip`. Validate those values dynamically according to §2.1; never hard-code private dataset statistics or checksum in the runner or tests.

**JSONL contract from exporter v2 (inspected in full)**: one JSON object per line: `{ "received_at": "...", "legacy_stored_rows": <integer>, "payload": [<sanitized webhook event>, ...] }`. The actual JSONL line count is private and must equal the corresponding manifest field. The `received_at` value is **MIN(created_at)** for the legacy rows in a distinct raw-JSONB group; it is NOT a verified original HTTP arrival timestamp. The JSONB contents are not byte-identical original HTTP bodies.

**UTC timestamp representation (Owner-approved compatibility amendment):** both JSONL `received_at` and manifest `cutoff_utc` must use `YYYY-MM-DD[T or space]HH:mm:ss` with an optional fractional part of one through six digits and exactly one of `Z`, `+00`, or `+00:00`. Equivalent suffixes normalize to the same UTC instant. Require a real calendar date/time, including leap-day validation; reject nonzero offsets (including `+01:00`), negative-zero offsets, malformed offsets, local times and other timezone spellings. Sub-millisecond receipt precision loss is reported for all three suffixes. This representation amendment does not alter source event timestamps or FP-001 normalization.

**Never conflate** legacy stored rows, distinct legacy JSONB payload groups, sanitized payload hashes, physical HTTP deliveries, and FP-001 semantic-deduplicated events. Source distinct groups can collide *after* sanitization removes non-allowlisted fields. The runner must measure this explicitly; do not assert any Fair stored-batch count without verifying sanitized content hashes.

### 2.1. Approved manifest contract (FP-003A; v1 and existing unversioned exporter-v2 manifests)

This section resolves the previously unspecified manifest/schema-version boundary. It is **authoritative for FP-003A**. The Owner's existing one-day gzip and manifest **must work unchanged**; the real manifest and dataset must never be copied to agent worktrees, GitHub, or CI. Only synthetic fixture manifests may be committed. This is the manifest format produced by the existing offline `fair_replay_export_v2.py`; it is not an upstream Pasarguard API contract.

**Version dispatch:**

- `manifest_version` is the **only** recognized version field (not `version`, `schema_version`, or `format_version`). When it is **present**, its JSON value must be the integer `1` (not a string, float, boolean, or `null`). The versioned-v1 payload uses the field contract below.
- When `manifest_version` is **absent**, recognize the already-exported **legacy unversioned exporter-v2 format**. Validate it against **the same required field contract** below, with the same fixed `source`, types, limits, and preflight checks. Accepting an absent version is a deliberately narrow backward-compatibility rule; do not interpret arbitrary unversioned JSON as compatible.
- If any other explicit version or version alias is present, reject with a **sanitized, fixed-code** `UNSUPPORTED_MANIFEST_VERSION` or `INVALID_MANIFEST` error. Do not log manifest contents.
- Future versions are unsupported until separately approved. **Do not require the Owner to regenerate or hand-edit the previously exported one-day manifest.** Version handling must not alter gzip input, its SHA-256, or the behavior of FP-001.

**Required fields** (exact case-sensitive names in a UTF-8 JSON object; no coercion):

| Field | Type and permitted values | Meaning / validation |
| --- | --- | --- |
| `source` | string, exactly `legacy-pasarjew-postgresql` | Provenance label only; no network connection is authorized. |
| `window_days` | JSON integer, exactly `1`, `7`, or `30` | Nested extraction window before `cutoff_utc`; no other windows approved. |
| `cutoff_utc` | nonempty valid UTC timestamp string, e.g. `2026-01-15 12:00:00.000000+00` | Accept the UTC timestamp representation defined above, with exactly `Z`, `+00`, or `+00:00` and zero through six fractional digits; require a real date/time and UTC, not an arbitrary timezone or local time. The runner does not derive a new cutoff from its wall clock. |
| `distinct_payload_groups` | positive safe JSON integer | Number of JSONL lines / distinct pre-sanitization legacy JSONB groups. It is **not** guaranteed to equal distinct post-sanitization batches. |
| `legacy_stored_rows` | nonnegative safe JSON integer | Sum of `legacy_stored_rows` across JSONL lines; historical duplicate rows, **not** independent HTTP deliveries. |
| `replay_event_children` | positive safe JSON integer | Sum of `payload.length` across JSONL lines **before** FP-001 validation/deduplication. |
| `groups_with_repetition_mismatch` | safe integer, `0..distinct_payload_groups` | Count of lines whose `legacy_stored_rows !== payload.length`. Verify against computed value; nonzero is an explicit discrepancy, not silently repaired. |
| `actor_object_null_id_events` | safe integer, `0..replay_event_children` | Count of **child occurrences** where `by` is an object with its **own** `id` key explicitly set to JSON `null`; do not count missing `by`, `by=null`, missing `by.id`, or non-null IDs. |
| `action_counts` | nonempty JSON object: action label → positive safe JSON integer | See action aggregation contract below. |
| `sha256_gzip` | string of exactly 64 lowercase hex characters (`^[0-9a-f]{64}$`) | SHA-256 of the **gzip file's original bytes**, not uncompressed data, JSON canonicalization, or the manifest. Must match the supplied input before any ingestion. |

**Optional fields:** `notes` may be an arbitrary UTF-8 string of at most 512 characters; never copy or print it. `manifest_version` may be present only as integer `1` per the version rule above. All other keys, including unapproved aliases and embedded data, are rejected. Every integer must satisfy `Number.isSafeInteger`, be non-boolean/non-float, and obey the stated bounds. Reject duplicate JSON object keys where the parser can detect them; never silently reinterpret fields. Reject oversized manifest files before JSON parsing (conservative limit: 64 KiB).

**Action-count contract:**

- Keys are exact, case-sensitive **source action** strings taken from each sanitized JSONL child as `child.action`, **before** FP-001 normalization, filtering, retries, or semantic deduplication. Do not use the legacy row `action` column or Fair persisted `pasarguard_events.action` to construct these source counts.
- Valid action keys are printable ASCII tokens matching `^[A-Za-z0-9_:-]{1,64}$`; the exporter-v2 fallback literal `(missing)` is additionally allowed when a child lacks the `action` key. Do **not** restrict the source labels to today's known FP-001 action list: unexpected but well-formed actions must remain visible as potential `UNKNOWN_ACTION` findings. If a child has a non-string action, reject the preflight input as malformed rather than inventing an action count.
- Values are **positive safe JSON integers** (no zero-count keys). The sum of values must equal `replay_event_children`. Recompute the full map from **every JSONL child occurrence** and require exact key/value equality with the manifest, regardless of JSON object key order. Do not count unique semantic events, distinct batches, or only accepted children.
- Verify `distinct_payload_groups == JSONL line count`; `legacy_stored_rows == sum(line.legacy_stored_rows)`; `replay_event_children == sum(line.payload.length)`; `groups_with_repetition_mismatch == count(line.legacy_stored_rows !== line.payload.length)`; and `actor_object_null_id_events == count(explicit by.id=null in child objects)`. A source `legacy_stored_rows` value must be a nonnegative safe integer. Validate every line's required keys and child-array shape before using the counters.
- The one-day **observational** counts stated elsewhere in this spec are a reference/acceptance case, **not hardcoded parsing rules**. Seven-day and thirty-day manifests must be validated against their own stated counts and the same fixed cutoff, not the one-day numeric constants.

**Synthetic shape example (illustrative only; NOT the Owner's manifest or an executable checksum fixture):**

```json
{
  "manifest_version": 1,
  "source": "legacy-pasarjew-postgresql",
  "window_days": 1,
  "cutoff_utc": "2026-01-15 12:00:00.000000+00",
  "distinct_payload_groups": 2,
  "legacy_stored_rows": 3,
  "replay_event_children": 3,
  "groups_with_repetition_mismatch": 0,
  "actor_object_null_id_events": 1,
  "action_counts": {
    "data_usage_reset": 1,
    "user_created": 1,
    "user_updated": 1
  },
  "notes": "Fully synthetic illustration; do not use with a real replay file.",
  "sha256_gzip": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The illustrated SHA-256 is a **placeholder with the correct syntax**, not the digest of a real fixture. Synthetic automated tests must compute the checksum of their actual synthetic `.jsonl.gz` fixture bytes and set `sha256_gzip` accordingly. The corresponding *unversioned compatibility fixture* is the same synthetic object **with only `manifest_version` removed**. Both versions must pass when paired with their own correctly checksummed synthetic input. Tests must also reject explicit `manifest_version: 0`, `2`, `"1"`, `null`, malformed or missing `action_counts`, mismatched action totals, and unknown manifest fields.

**Failure behavior:** reject invalid manifest, checksum mismatch, tampered/oversize/malformed JSONL, and count discrepancies *before any database container starts or ingestion occurs*. Return sanitized fixed-code failures without including input data, field values containing user content, usernames, hashes from an untrusted file, or raw parser/driver diagnostics. A genuinely nonzero but correctly declared repetition-mismatch count is a separate explicit analytical finding; do not silently change the expected number of input lines/events.

## 3. Safety and scope constraints

1. Runner runs **locally/offline** and **only against a disposable PostgreSQL 17 Testcontainers-managed database** created by the harness. Never accept arbitrary runtime/prod `DATABASE_URL` as a replay target. Provision and run the *existing* FP-001 migration in that database; use the existing FP-001 `DurableInbox`, `BatchProcessor`, `PayloadEncryption`, and required configuration rather than reimplementing ingestion.
2. Neither call production `apps/api`/real webhook endpoints nor activate production webhook authentication bypass. No connection to Pasarguard/Pasarjew or any live service is allowed. Testcontainers may require an image pull if PostgreSQL 17 is not already cached; that is not permission to connect to production systems. Do not require production secrets. A fresh random, disposable encryption key is allowed for the ephemeral test database only.
3. Never write historical data to source control, GitHub Actions logs/artifacts, issues, comments, test snapshots, screenshot fixtures, telemetry, or application log output. Treat pseudonymized business data as private despite removed URLs/secrets. Keep the local input files outside tracked worktrees; read-only access and default-safe output permissions. Synthetic fixtures only in source and CI.
4. Do not change domain/accounting/business interpretation; do not make `by.id = null` silently valid, change source payloads, or substitute Billing Admin for missing Actor Admin. Report observed FP-001 validation behavior as a finding and require separate Owner approval for contract changes.
5. No worker → accounting connection, pricing, report delivery, external actions, migrations against production, data purge, or changes to Pasarjew/Pasarguard. Existing production `VERIFIED_WEBHOOK_AUTHENTICATOR_REQUIRED` fail-closed behavior must remain unchanged.

## 4. CLI behavior

- Explicit `--input <absolute or resolved path>` and `--manifest <path>`, plus explicit offline/disposable semantics; reject missing/unreadable/malformed files.
- Validate SHA256 of gzip bytes against `manifest.sha256_gzip` **before** processing, using the approved versioned/unversioned manifest contract in §2.1. Safely stream gzip JSONL with bounded line/batch sizes; avoid materializing all records in memory.
- Preflight: count lines, logical children, aggregate actions, sum `legacy_stored_rows`, detect mismatches, validate JSONL envelope and original manifest. Calculate the number of **distinct sanitized canonical payload hashes**, including any different legacy groups collapsed to identical post-sanitization payloads. Verify the known one-day manifest and report any mismatch as a failed input-integrity gate.
- Use FP-001 inbox with each sanitized `payload` and source receipt metadata. If passing `received_at` through JS `Date`, report that its sub-millisecond precision is truncated; do not falsely claim exact preservation of PostgreSQL microseconds. Event chronology remains from `event.enqueued_at`, independent of `received_at`.
- Execute existing `BatchProcessor.processNext()` until no claimable batches remain; implement bounded retries/no-progress safeguards. Never bypass normal FP-001 normalization rules.
- Query and report final persisted batch states, normalized events/statuses, ingestion issue codes, distinct sanitized batch hashes, duplicate/invalid event counts, and per-action totals; clearly distinguish source input counts from Fair stored entities.
- Count and report the source `by.id = null` subset from input and manifest. Current FP-001 schema rejects a present Actor Object with null ID; measure actual resulting issues and record discrepancies. Do not assume the other children necessarily normalize or are semantically unique.
- Optional second pass into the SAME disposable database to verify replay idempotency: report initial/final stored batch/event counts and any new issues without treating historical `legacy_stored_rows` as separate deliveries.
- Emit only a **privacy-safe JSON summary** and readable stdout summary. No per-user rows, pseudonymous identifiers, webhook JSON, raw database driver errors, or confidential values in reports. Write output files outside tracked repo directories with restrictive permissions; redact error details. CLI exits nonzero on checksum, structural, migration, storage, processing or invariant failures; expected input validation issues are reported, not silently discarded.
- Dispose the database/containers and close handles even on exceptions. An optional persistent analysis database is **out of scope** for FP-003A pending independent approval.

## 5. Expected verification levels

- **Input-integrity checks:** verify actual JSONL group count, child count, and repetition mismatches against the supplied private manifest; gzip hash and action counts must match. Never hard-code real dataset counts.
- **Operational checks:** each sanitized distinct batch is either normalized or in explicit failed state with a reason; no hanging pending/in-progress state; issues and statuses reconcile with actual DB rows; event/receipt time ordering is not assumed.
- **Differential report:** source group count vs sanitized distinct batch count vs stored batch count; input event children vs successful normalized vs rejected vs duplicate semantic events, with any differences labeled and explained rather than forcing false equality.
- **Behavior validation:** count actor-null-ID input occurrences and measure their actual outcomes under current FP-001 contract (not auto-fixed); identify any further invalid fields or unverified behaviors. Distinguish an invalid child from an accepted child that also emits a warning, and do not assume all issue counters are mutually exclusive.
- **Replay repeatability:** rerun from an empty disposable database and get stable aggregate results; a second identical import into the same DB does not create duplicate stored batches or duplicate normalized semantic events. If existing FP-001 deduplication causes a different issue count on repeated delivery, record it rather than falsifying equality.
- **Test suite:** synthetic unit tests for parser/preflight/checksum/reporting; integration/E2E with real PostgreSQL 17 Testcontainers through existing inbox/worker; adversarial cases include tampered gzip, malformed JSONL, disallowed input shape, sanitized payload collision, duplicate batches, missing/null Actor IDs, empty inputs, failed DB connection and clean resource disposal. Full existing 192-test baseline must continue to pass (total may increase).
- **Quality:** frozen install, format, lint, typecheck, full tests, build, independent Review/QA, and passing PR `quality` GitHub Actions.

## 6. Later windows and limitations

After Owner inspects one-day results, generate and test **7 days, then 30 days**, using the same server-side HMAC key and the **same fixed UTC cutoff**. Recheck counts against each newly generated private manifest; full seven-day and thirty-day exports have not yet been executed. The grouping and boundary limitations apply to every window; earlier manifests should not be assumed to combine additively because the windows are nested.

Even full operational replay success does **not** establish pricing, correct amounts owed, correlation, or live Pasarguard webhook compatibility. Historical SQL JSONB evidence is not the current upstream wire/auth contract.

## 7. Explicit implementation decisions and escalation boundaries

1. Treat each JSONL line as **one candidate legacy batch**, not as `legacy_stored_rows` individual HTTP requests. Exactly one `DurableInbox.receive()` call per JSONL line in the initial pass.
2. A sanitized canonical-payload collision is **not automatically a replay failure**: compute and report distinct counts before/after sanitization. Fail only if actual Fair storage diverges from the expected distinct sanitized batches, or if integrity/processing invariants fail.
3. FP-001's allowed input type is a JSON array or supported singleton. The historical file contains arrays; the CLI must reject unexpected envelope shapes before ingestion rather than inventing wrappers.
4. Preserve event `enqueued_at` and `send_at` as supplied numeric Unix seconds and preserve all batch child ordering. `received_at` is a legacy approximation, not canonical source chronology, and JS Date precision loss must be explicitly documented.
5. Ensure one-day reports are privacy-safe aggregates only. Report input action counts, Fair persisted action counts, processing statuses, ingestion issues by code, and source-versus-Fair count differences. Add a machine-readable schema/version in the report for future 7/30-day comparisons.
6. If code changes appear necessary in `packages/pasarguard` or `packages/accounting`, stop and escalate. **No change to FP-001 normalization, its fingerprint algorithm, its original migrations, or FP-002 financial foundations is approved in this task.**
7. Parser safety: bounded streaming decompression and per-line sizes with deterministic errors; do not accept a directory path as input; reject malformed manifest and unsupported manifest versions without dumping private content to stderr.
8. CI and agent development must use synthetic fixtures only. **The Implementation/Review/QA agents must not read or copy the Owner's private real replay file** merely to implement or validate the feature. After agent QA, the Owner runs the command locally against the private file and shares only safe aggregate results.
9. Run the existing FP-001 migrations using the Testcontainers-owned connection and destroy it in a `finally` path. Never use or fall back to `process.env.DATABASE_URL` or a user-supplied URL for this tool.

## 8. Implementation handoff


- Work only on a new `feature/fp-003-historical-replay` branch from current `development`, with a **Draft PR** to `development`.
- Implementation Agent makes focused changes and tests; independent Review Agent then QA Agent verify; follow repo `docs/AGENT_WORKFLOW.md` and `docs/DEFINITION_OF_DONE.md`.
- No direct `development`/`main` pushes, no merges, no deployment, no production secrets/access, no broad runtime changes without documented approval.
- A separate design decision will settle FP-003B dashboard access (SSH tunnel/private network vs public HTTPS) and Owner authentication implementation; FP-003A must not preempt that choice.

## 9. Deliverables and acceptance checklist

- [ ] Dedicated CLI package/script documented with sample commands using synthetic fixture paths; optional `--out` must default to an outside-repo private destination.
- [ ] Strong input integrity gate: gzip SHA-256, JSONL structure, source-manifest event/action totals, and bounded decompression all verified before DB use.
- [ ] Disposable PostgreSQL 17/Testcontainers, original FP-001 migration, existing inbox and processor; all connections and containers closed on success/failure.
- [ ] First and second ingestion pass counts recorded; processing exhausts safely and reports any retry failures.
- [ ] Privacy-safe JSON result and compact stdout summary with provenance and limitations, no raw/individualized event values.
- [ ] Synthetic tests for invalid/null `by.id`, duplicate/overlapping semantic events, separate sanitized-payload collisions, bad hash, malformed JSONL, maliciously large input, exhausted processing, and resource cleanup.
- [ ] `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally and in CI.
- [ ] Independent Review and QA complete and report PASS before human merge permission.
- [ ] The Owner separately runs the real one-day dataset **after** implementation; record observed results without converting them into guessed business rules. Proceed to 7/30 days only after reviewing that result.

## 10. Human-controlled release boundary

The accepted division is: **FP-003A first** (replay verification), **FP-003B later** (Owner-only login, operational metrics API, dashboard). FP-003B dashboard exposure (private network versus HTTPS domain) remains undecided and is not a blocker for this offline harness. This specification authorizes no branch merge, production deployment, live webhook integration, accounting activation, or changes to Pasarjew. The human Owner controls all merges and access to private data.

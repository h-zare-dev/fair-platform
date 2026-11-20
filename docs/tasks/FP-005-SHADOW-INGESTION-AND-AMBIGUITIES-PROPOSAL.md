# FP-005 — User-create shadow accounting, replay evidence, and ambiguity UI

**Status: PROPOSED IMPLEMENTATION SPEC; OWNER REVIEW REQUIRED BEFORE FEATURE CODE.**
**Branch of record:** `development`. **Milestone:** FP-005 (User Create).
**Related:** `DOMAIN_RULES.md`, `ARCHITECTURE.md`, `integrations/PASARGUARD.md`,
`FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md`, ADR 0018, FP-001/001B/002/003A/004.

This task is deliberately bounded to the approved **user-create** milestone.
The Owner also requested that real historical events, reset/update ambiguity
and nightly accounting eventually be visible in Fair Platform. **This document
does not itself authorize importing private history into public Staging,
activating any live source webhook, sending reports, or merging a PR.**
FP-006 owns previous-state/update semantics; FP-007 owns renewal/reset and
Next Plan semantics. Their events must be retained, not silently charged as
part of FP-005.

## 1. Current implementation and evidence boundary

- FP-001 already has authenticated durable batches, encrypted temporary raw
  payload, normalized events, idempotent worker and technical ingestion issues.
  FP-003A has a disposable PostgreSQL offline replay harness. FP-002 defines
  immutable SHADOW transactions and accounting exceptions, but does not
  classify events or run night-close.
- The Owner dashboard already lists **ingestion** events/issues, but there is
  no separate **financial ambiguity** view, no automatic user-create shadow
  classification, no verified nightly charge, and no persisted daily closure.
- The normalized event currently omits billing-relevant, non-secret upstream
  fields such as account `created_at`, `expire`, `edit_at` and
  `on_hold_expire_duration`. Once encrypted raw retention expires, a fixed
  package's original duration may be irrecoverable. Preserve verified fields
  additively before any financial classifier consumes normalized rows.
- Private legacy replay observations establish that on-hold duration may be
  supplied as exact seconds; active-account dates may represent accumulated
  renewals; and a reset, update and status change can reflect a related source
  operation. These are **hypotheses to test against authenticated source
  contract and independently approved fixtures**, not a license to invent
  source semantics. Do not publish private replay counts, identities,
  timestamps, file names, hashes or fixtures in Git.

## 2. Environments and prohibited shortcuts

1. Keep the current public `panel.fairisfair.ir` **synthetic-only**. Synthetic
   demonstrations may populate its existing sandbox PostgreSQL, but *never*
   copy the Owner's private 30-day replay, HMAC identity key, pseudonymized
   user-level records or actual production webhook bodies to this host.
2. Run historical replay against a **disposable isolated PostgreSQL 17** on a
   trusted local/private environment, with no outbound messaging or live
   billing. Produce an aggregate report with deterministic reconciliation and
   zero sample identifiers, not a public dataset. Existing manifest hash,
   bounded decompression and no-secret-fixture protections remain mandatory.
3. Real live-webhook shadow ingestion requires its **own approved operational
   environment** with an explicit data-protection, retention, access, backup
   and restore decision. ADR 0017's deliberate *no-backup synthetic Staging*
   exception does **not** authorize storing real billing evidence there.
4. The existing legacy Pasarjew/PasarGuard webhook endpoint must remain
   untouched. A second destination may be configured only by the Owner after
   receiver-auth, independent failure/timeout isolation, retries, late events,
   throughput and comparison tests. Never use the Pasarguard database as a
   substitute source; read-only API admin-directory access is separate.
5. No production secrets in PRs, GitHub artifacts, tests, screenshots or logs.
   The normal Owner-only Draft → Ready → Merge and protected CI rules apply.

## 3. Phase 1 — Capture the verified billing projection (no money)

- Add forward-only nullable PostgreSQL columns for `source_user_created_at`,
  `source_user_expire_at`, `source_user_edit_at` and
  `on_hold_expire_duration_seconds` to `pasarguard_events`, with
  corresponding TypeORM mapping and strict bounded normalization. Preserve
  absent/null values as null. Seconds are integer-safe and must not be
  confused with days or timestamps.
- Keep canonical `data_limit_bytes` as exact integer bytes. An eligible
  on-hold duration `2592000` seconds may become exactly 30 **package days**
  only after source semantics are verified; never derive duration from a
  Persian/Gregorian month name. Values not divisible by 86,400 seconds require
  explicit review rather than rounding to a nearby integer day.
- Do not infer a used template ID/name, an administrative actor, or a charge
  from the absence of these fields. Pasarguard templates are optional;
  package matching is exact `(bytes, duration_days)` regardless of template
  usage. `by.id=null` is retained independently from Billing Admin.
- Keep unique batch/semantic fingerprint behavior; **do not** alter already
  stored event identity on migration. New columns on an old normalized event
  remain null unless a separately approved deterministic backfill proves the
  original source values.
- Add contract tests for valid on-hold seconds, active/null expiration,
  fractional GiB byte values, unexpected unlimited data, dates with UTC
  offsets, malformed optional fields, and nullable/missing Actor metadata.
  No raw sensitive fields are normalized or returned from Owner APIs.

## 4. Phase 2 — Nightly user-create operation and day state

- **No financial calculations on webhook receipt.** Create candidates at the
  configured night-close for each source/Billing Admin/Jalali day; record a
  source timestamp and local `FAIR_TIME_ZONE` conversion. Never use
  `received_at` as the business-date key.
- Freeze the complete end-of-day group, package assignment, exact price,
  timezone, period bounds and source watermark **as of local midnight**,
  independent of when the actual job runs. An unprovable reconstruction
  becomes a blocking exception, not the latest group/price.
- In FP-005, classify *verified* independent `user_created` operations.
  On-hold and active creations are equally potentially billable. A known
  positive, integral-day source duration and exact fixed package match (or a
  separately authorized applicable per-GiB-only rule) are prerequisites to
  financial posting. A trial-sized or unusually short package is **not**
  assumed free or paid solely by its size.
- Do not automatically cancel a Create when a Delete/Recreate occurs the same
  day. Without proven stable identity and correction semantics, use
  `AMBIGUOUS_CORRECTION`. A repeated delivery of the *same* source operation
  must not create another charge.
- Store an idempotent admin/day status and frozen context transactionally.
  If unresolved financially blocking items exist, mark only that admin/day
  `PENDING_REVIEW`; never silently produce a zero bill. Later days remain
  independently eligible. Do not finalize incomplete history or infer
  baseline for users whose creation predates the source window.
- After full acceptance, the FP-002 immutable SHADOW ledger may be used only
  at nightly close with event linkage and an immutable daily summary.
  No LIVE posting, Telegram delivery, weekly/monthly report or refund in
  this milestone.

## 5. Phase 3 — Dedicated Owner ambiguity listing

- Keep ingestion failures and accounting ambiguities **separate** in the UI:
  `خطاهای دریافت` for malformed/unsupported webhooks and `ابهامات
  حسابداری` for valid-but-unpriceable operations.
- New Owner-only, paginated, allowlisted `GET` endpoints list counts and
  cases grouped by `(source, Billing Admin, Jalali business date)`, with
  status, typed reason, source event references, exact bytes rendered as GiB,
  source and receipt timestamps, and non-secret provenance. Filter by
  open/resolved, admin, reason, and date. Do not expose customer usernames,
  HMAC keys, raw payloads, subscription URLs or proxy secrets in this view.
- Required typed reasons at minimum: `MISSING_DURATION`,
  `PRICING_MISSING`, `UNEXPECTED_UNLIMITED`,
  `PREVIOUS_STATE_MISSING`, `AMBIGUOUS_CORRELATION`,
  `AMBIGUOUS_CORRECTION`, `UNKNOWN_WEBHOOK_EVENT`,
  `PRICING_CONFIG_CONFLICT`, `LATE_EVENT_AFTER_CLOSE`.
  Existing FP-002 `accounting_exceptions` has an `OPEN`-only DB
  constraint: use a separate **forward-only migration** and append-only
  resolution audit; never rewrite the original migration.
- Review actions must not enable arbitrary backdated postings or edits to
  finalized reports. A formally approved resolution reprocesses only the
  held day with its frozen context, idempotently. Where source semantics are
  still unverified, show **awaiting evidence** without an action that silently
  selects a price. Replayed private records never become public UI fixtures.
- Persian presentation uses `پکیج` rather than old UI naming; clearly label
  synthetic preview as **آزمایشی / بدون صورتحساب واقعی**.

## 6. Replay and verification gates

1. Reuse the existing FP-003A manifest-protected loader **offline** and
   compare raw child occurrences, normalized events, rejected children,
   missing Actors and repeated-ingestion idempotency without emitting private
   per-user values. Exact totals remain in private Owner evidence only.
2. Validate Create/on-hold bytes+duration and active/null-duration cases,
   followed by an intentionally unmatched/manual package and a per-GiB-only
   group. Missing shape/rate yields a typed ambiguity, not zero or guessing.
3. Validate source-time vs HTTP-receipt-time business date crossing in
   `Asia/Tehran`, Berlin DST long/short days, Jalali
   Shahrivar/Esfand/Nowruz boundaries, Owner-configured runtime/grace and
   concurrency/missed-scheduler catches.
4. Validate Reset+Update near 120 seconds and out-of-order signals as
   **retained pending FP-007 evidence**, never FP-005 duplicate charge.
   Unknown Next Plan and late-after-finalized events must be visible and not
   silently discarded.
5. PostgreSQL 17 migration upgrade/downgrade in disposable CI only,
   reprocessing after failure, duplicate deliveries and bounded pagination;
   Owner authorization/CSRF and forbidden public API reads; no secret
   leakage. Full quality/security/containers CI and independent review.
6. Before any real webhook activation: explicit Owner environment and
   retention/backup sign-off, production-safe receiver secret provisioning,
   independent endpoint failure tests proving no regression to the old bot,
   traffic comparison in shadow mode and rollout/rollback runbook.

## 7. Decisions that must precede real-data rollout

1. **Where is real shadow data stored?** Recommended: a separate private,
   access-controlled shadow environment with recoverable backups. Alternative:
   a separately reviewed change of the public Staging policy, network/data
   protection, and backup decision. Do not select this by inference.
2. **What proves active-user package duration and historical baselines?**
   Source-proven supplemental fields or separately approved read-only API
   evidence; `expire - created_at` alone is insufficient for renewals.
3. **What is the Owner-approved adjustment path for events that arrive after
   a daily report is `FINALIZED`?** Record/hold them until explicitly
   approved; never mutate or silently forgive an immutable report.
4. **When is FP-007 reset correlation considered production-proven?** Private
   replay agreement alone is insufficient to enable live charges.

This document is a scoped task proposal, **not** evidence of implementing,
deploying, billing, importing or releasing FP-005.

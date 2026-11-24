# FP-006 — Initial accounting setup: replaceable opening snapshot

> **Status: Owner-requested DESIGN PROPOSAL, 2026-11-24. Not implementation authorization.**
> This document specifies a UI and state lifecycle for the existing read-only opening
> baseline. It does **not** authorize deleting records, enabling webhooks, making
> accounting entries, publishing reports, or deploying. Review and approve the
> exact semantics below before a separate implementation PR.

## 1. Problem, intent, and the current implementation

The Owner is testing on Staging, has **not connected the new webhook**, and has
**not declared an accounting cutover**. They want to repeatedly discard an
opening import *as the effective baseline* and re-read all current accounts from
the authorized PasarGuard directory. This should be discoverable in **Settings →
Initial setup**, instead of occupying the Operations dashboard.

As of `development` commit `67f31cb`:

- `OpeningBaseline` is in `apps/web/components/dashboard.tsx` and offers
  **Run new import**. `GET/POST /api/v1/owner/operations/accounting/opening-baseline`
  reads the latest run and creates another `PENDING` run, respectively.
- The two-pass source scan/verification is non-posting; it handles concurrent
  additions and removals by reporting them, not by requiring a frozen source
  count. Existing users receive **no opening debt**.
- The PostgreSQL `fair_opening_baseline_runs` and
  `fair_opening_baseline_users` retain run-scoped evidence. A database trigger
  forbids deleting baseline users and altering completed/failed evidence.
- There is currently **no distinct, approved accounting cutover/active baseline
  pointer**. A successful historical import is not proof of webhook continuity,
  duration completeness, or permission to post financial entries.

The latest Staging screen supplied by the Owner shows run `3`, `COMPLETE` in
`VERIFY`: first pass 28,902 accounts; 28,893 with no material difference,
8 material changes, 1 missing by verification, 28,901 at last source check.
These are observational counts, not an immutable financial opening balance.

## 2. User experience

### Location and name

- Add a third Settings navigation item:
  **«راه‌اندازی اولیه»**, subtitle **«دریافت وضعیت اکانت‌ها»**.
- Proposed route: `/settings/initialization`; preserve the existing
  `/settings/packages` and `/settings/groups` sections and Owner authentication.
- Move the current `OpeningBaseline` display/action out of the Operations
  dashboard to this page; share the existing source adapter and status endpoint.
- The page explains: **«فقط دریافت اطلاعات اولیه؛ بدون ثبت بدهی یا اتصال وب‌هوک»**.

### Page layout

1. **Prerequisites:** PasarGuard read-only source availability, new webhook
   state, financial-cutover lock state, previous run and its usable status.
   `Webhook not connected` is valid and **does not block a read-only scan**.
2. **Latest opening snapshot:** source instance, run/generation ID, timestamps,
   phases, scanned and verified totals, material/immaterial changes, added and
   missing accounts, unresolved original duration and other incompleteness.
   Report source churn separately from errors. Show the previous complete run
   as history, *not* as the new run's users.
3. **Controls:**
   - No snapshot: **«دریافت اولیه از پاسارگارد»**.
   - Existing snapshot, before cutover: **«بازنشانی و دریافت مجدد»**. This
     is the single Owner-requested one-click *workflow*: after confirmation,
     replace the effective snapshot with a completely new run; never append
     the new roster into the old run.
   - In-progress import: show progress, disable start/reseed, offer safe retry
     guidance after a genuine FAILED run. Page refresh never restarts a run.
   - After cutover or if accounting activity cannot be ruled out: show a
     **locked** state; no reset button, only a reason and link to manual review.
4. **Confirmation dialog:** say which active run will be superseded, that the
   new scan has no opening charge, that events/prices/groups are not erased,
   and that all currently active snapshot data will be replaced **for future
   initialization**. Require deliberate Owner confirmation, not a background
   request on page load; display run ID and an audit confirmation afterwards.
5. **Accessibility:** RTL Persian, keyboard/focus-managed confirmation, status
   announcements, clear `RUNNING/FAILED/COMPLETE` labels, and safe error retry.

### Meaning of “clear previous data”

**Functional clearing, not physical deletion, is the safe default:**

- Mark the previous opening run as **superseded for activation** and select a
  new generation/run. On the new run, account rows start empty and are populated
  only from the new scan. No old account may leak into the new generation.
- Retain old run-scoped rows as immutable, audit-only history, consistent with
  the existing database guard. The active initialization view must not merge or
  sum historical generations. Listing previous runs is optional, but the active
  generation and superseded state must be unambiguous.
- **Never clear** 25 approved package prices, group memberships/assignments,
  prior replay imports, webhook batches, normalized events, ledger, reports,
  financial postings, or logs under the name “opening reset.” Those are
  independent business objects.
- Physically deleting the old baseline rows would require **separate explicit
  Owner approval**, an audited Staging-only destructive procedure and a deliberate
  change to the existing immutability rule. It is **not part of this button**.

## 3. Data model and state machine

Existing run statuses remain `PENDING`, `SCANNING`, `VERIFYING`, `COMPLETE`,
`FAILED`. **Proposed new initialization-selection state**, separate from run
status, records the source instance, generation, selected run ID (nullable),
selected-at timestamp, selected-by Owner, superseded-by generation, and the
cutover lock/cutover reference once that separate milestone is implemented.
Do not overload `COMPLETE` to mean `ACTIVE_FOR_BILLING`.

The actual implementation must specify a safe staging transition:

1. `NO_SELECTION → RUNNING`: start scan `N` (no posting).
2. `RUNNING → COMPLETE`: the candidate run completes both passes. Only then
   may it become the *selected opening snapshot for review*; it is **not**
   a LIVE accounting baseline.
3. `SELECTED(N) → RUNNING(N+1)` on reseed: immediately mark `N` ineffective
   for prospective cutover, and create `N+1` atomically. If `N+1` fails,
   show `FAILED` and **no automatically restored/hidden active selection**.
   The Owner can explicitly start another run; previous evidence remains.
4. `SELECTED(N+1)` only after successful verify and review. No auto-financial
   activation, no old/new roster union, no automatic opening debit.
5. `CUTOVER_LOCKED`: all reseed/reset commands fail closed before any mutation.
   Once even one financial period/report uses a baseline generation, reuse the
   immutable financial-adjustment/reconciliation workflow instead.

For a simpler initial implementation, the selection state can be designed with
the existing run table and a small new pointer/audit table, **but `MAX(run_id)`
must not silently select an older complete baseline when a newer reseed fails**.
The source-instance boundary and migrations must be explicit.

## 4. API, permissions and safety checks (proposed)

Use the existing Owner-only read endpoint for inspection, extend it to report
selected generation and reseed eligibility, and add a clearly named,
idempotent **Owner-only** reseed command, e.g.:

`POST /api/v1/owner/operations/accounting/opening-baseline/reseed`

Required before committing the reset/start transaction:

- Valid Owner session and CSRF protection; reject unauthenticated or non-Owner.
- Check the server's authoritative `financial cutover not started` lock, not a
  browser checkbox or editable environment string. Verify no related financial
  opening/closed ledger or committed report exists; if the cutover subsystem is
  unavailable or the check is uncertain, **deny**, never guess.
- Reject a concurrent scan/reseed on the same source instance with database
  serialization; do not rely only on a disabled UI button. Use a request nonce /
  idempotency key so retry and double-click return the same new run.
- Transition the old selection and create the next run atomically; recover
  safely from crash/restart. The background scanner must only write to its own
  run ID and never touch an earlier generation.
- Keep a minimal immutable audit entry: Owner, source, old/new run, action,
  UTC timestamp, idempotency key, outcome and reason; never store credentials.
- Strictly read-only upstream: no PasarGuard user modification, no webhook
  activation, no credit/balance mutation, no ledger or report creation.

The existing `POST .../opening-baseline` is already sufficient to **start
another independent immutable run**. The new command/state is needed for an
explicit **reset-and-replace lifecycle and cutover gate**, not to reimplement
the scan or delete rows.

## 5. Verification and acceptance criteria

- Settings contains **Initial setup**, the Operations dashboard no longer
  contains the importer, and Owner-only navigation/session behavior is intact.
- Before webhook setup, the first import and any number of deliberate reseeds
  work. Each starts an empty run-scoped roster; old snapshots never influence
  new totals or prospective cutover.
- Concurrent `add/delete/update` changes in the upstream directory during
  scan produce verified change/missing reports; they do not abort merely due
  to changed total count or silently reclassify churn as unchanged.
- A second click, two Owner browser tabs, an HTTP retry, and two API workers
  cannot create competing selected generations.
- A failed or interrupted new scan never silently falls back to the old run as
  current, and is safely restartable under the existing lease/worker design.
- A valid CSRF-less, non-Owner, or post-cutover reseed is rejected without
  changing any database rows. Unknown cutover state also fails closed.
- After a reseed, all catalogs, group assignments, replay history, webhook
  events, financial state and report state are unchanged, proven by regression
  tests. No opening debt, financial posting or notifications occur.
- Unit, PostgreSQL integration, API authorization, Next.js/UI accessibility,
  CI/release checks and Staging screenshots verify the feature. Never test
  destructive removal of shared financial state on the user's host.

## 6. Accounting readiness and dependency order

This page is **initialization tooling**, not the last step to production.
The following statuses distinguish what is verified in the current code from
the target design. Existing historical docs may call future features “done”
or “approved”; **approved design != implemented LIVE system**.

| Priority | Workstream | Current state and remaining work |
| --- | --- | --- |
| P0 | Owner setup and opening snapshot | Two-pass, read-only importer works; settings relocation, replaceable selection, explicit reset, and immutable cutover lock **not implemented**. |
| P0 | Source/identity and cutoff readiness | PasarGuard read-only directory and Shadow ingestion plumbing exist; verify correct production identities, initial roster, webhook coverage and replay-to-live boundary. The Owner says new webhook is **not connected yet**. Import alone does not prove duration/history for all existing accounts. |
| P0 | Final event interpretation: FP-005/006/007 | Create and Reset+Update read-only/what-if previews exist, including 10-minute ordered pairing and ambiguity reasons. Implement and validate complete **nightly financial** classification for Create, standalone Update, Reset, renewals, corrections, automatic resets, Next Plan, deleted accounts and missing previous state. Resolve remaining business policy questions (including optional Delete credit behavior) before any charge. |
| P0 | Durable nightly settlement & ledger | A limited Create-only `NightlyShadow` closer and prior ledger foundations exist, but not the Owner-approved all-operation, group/day, idempotent **LIVE** close, frozen historical prices, exception holds, atomic ledger/report/outbox workflow. Requires a separate approved implementation spec. |
| P0 | Exceptions and Owner resolution | Read-only ambiguity diagnosis exists; implement audited review/hold/resolve and resumption of a blocked `(source, admin, local date)` without repricing a finalized period. No guessed tariffs or durations. |
| P1 | Daily reports | No complete, immutable per-admin daily account statement with detailed charges/credits, settled state, and downloadable output has been verified in this code. Design report contents, persistence, access, audit and delivery. |
| P1 | Weekly and monthly reports | No implemented aggregate over **finalized daily snapshots** is verified. Must use the Jalali business calendar, await all affected days, and never recalculate old prices. |
| P1 | Telegram/email delivery and retry | No verified accounting report delivery/outbox service in this checkout. Specify destination consent/identity, idempotent sends, retries, failed-delivery handling, delivery receipts and Owner previews. Do not turn on real delivery until approved. |
| P1 | Financial correction/reconciliation | Post-finality adjustments, late webhook handling, restarts, day-boundary protection, group moves, numeric reconciliation against PasarGuard and duplicate-proof reruns need approval, code and tests before LIVE. |
| P1 | Release/operations | Secure webhook configuration, signed source validation, monitoring/alerts, reconciliation and acceptance tests (synthetic → replay → Staging live Shadow → audited first nightly close), Owner-controlled cutover and rollback/runbook. No automatic production activation. |

Suggested milestone order: **(1)** approve/implement settings reseed,
**(2)** confirm initial roster and source/webhook cutover protocol *without
enabling webhook yet*, **(3)** finish the financial interpretation and immutable
daily settlement with exceptions in SHADOW, **(4)** complete immutable daily
reports and weekly/monthly aggregation + delivery, **(5)** run end-to-end
Staging tests, **(6)** ask the Owner for a separate, deliberate webhook/cutover
authorization. Never treat an informational replay total as a payable balance.

## 7. Decisions required before implementation

1. **Recommended:** reset means **replace effective initialization and archive
   immutable previous runs**, never physically delete evidence. If physical
   deletion is essential for disposable Staging, request a **separate** bounded
   destructive procedure and approval, not a generic Settings button.
2. Confirm the future cutover-lock evidence source and lifecycle; do not rely
   solely on a boolean `webhook_connected=false` in the UI.
3. Confirm report channel(s), per-admin recipients, daily/weekly/monthly
   schedule and the simple optional Delete-credit policy separately from this
   import/reset feature.

### Source references

- `docs/DOMAIN_RULES.md`
- `docs/tasks/FP-006-OPENING-BASELINE-BOOTSTRAP.md`
- `docs/tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md`
- `apps/api/src/owner/infrastructure/opening-baseline{,-migration}.ts`
- `apps/api/src/owner/infrastructure/nightly-shadow.ts`
- `apps/api/src/owner/app.ts`
- `apps/web/components/opening-baseline.tsx`
- `apps/web/components/catalog.tsx`

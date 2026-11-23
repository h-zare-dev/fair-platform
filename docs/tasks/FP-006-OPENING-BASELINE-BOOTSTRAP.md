# FP-006 — Existing-account opening baseline bootstrap (Owner-directed 2026-11-23)

**Scope:** Owner-approved implementation request for a separate Draft PR after
the 2026-11-23 design discussion. Non-posting, read-only upstream, disposable
Staging SHADOW only. It does **not** authorize financial cutover or live posting.

## Why

On day one Fair may see approximately 15,000 pre-existing PasarGuard accounts
whose Create event predates all Fair webhooks. An opening *state* is required;
synthetic Create events and retroactive debit are forbidden. The earlier 30-day
archive is an independent historical test, not an authoritative current roster.

## Approved bounded implementation

1. Owner-only `POST /api/v1/owner/operations/accounting/opening-baseline`
   starts a durable one-source `primary` import, with Origin/CSRF/session
   validation. `GET` reports counters and readiness. No arbitrary upstream URL,
   token, source ID, billing date or monetary amount is accepted from the client.
2. The existing secret-mounted HTTPS PasarGuard API key is used only for GETs:
   `/api/users/simple?sort=id` to enumerate stable numeric IDs, followed by
   bounded `/api/users?ids=...` full detail batches. Full list mode (not the
   simple user response) exposes admin ID, bytes, status, expiration and
   `on_hold_expire_duration` where present. Sensitive proxy/subscription fields
   are discarded at the API adapter; never store upstream raw responses.
3. Persist the initial projection for every ID, then repeat a full ID/detail
   scan to flag `STABLE`, `CHANGED`, `MISSING` or `ADDED`. Pagination gaps,
   source-total drift, identity mismatch, invalid big integers, timeouts and
   malformed source data fail closed. Each page commits atomically with its
   offset and may resume after API/worker restart. Concurrent runs are rejected.
4. Existing accounts have **no opening CHARGE**, no fabricated historical
   `user_created`, no settlement/report/outbox writes, and no change to legacy
   webhooks. `postingScope=NONE`, `financialCutoverReady=false` even when the
   two-pass observation completes. The existing immutable historical replay
   and FP-006/FP-007 quote UI are not rewritten.
5. Do not infer a 30/60/90-day package from `expire-created_at` or remaining
   expiry. The source exposes an explicit on-hold duration when applicable,
   but an active account's original package duration may be unknowable from
   current-state fields. Preserve the evidence and report missing data.

## Important limit: two scans are NOT an atomic source snapshot

Changes between samples are detected where their final projection differs;
an update-and-revert (ABA), missing webhook, or source delete/recreate that
escaped both scans cannot be proven from API GETs. In this PR, a COMPLETED
import is *observed*, **not an approved opening cutoff**. A separate Owner-
approved FP-006 nightly financial cutover task must prove continuous durable
webhook coverage, reconcile events against the opening watermark, freeze the
opening date/Owner-admin tariffs and authorize the ledger transition. The
current SHADOW webhook must remain independent of legacy delivery.

## Owner acceptance

- Owner can start and follow progress on the Staging dashboard only after the
  read-only users API permission and existing SHADOW intake are configured.
- All non-sensitive user-count totals are shown; changed/missing/added/unknown
  admin/volume/duration are counted; no individual private record is exposed.
- No financial row is inserted by import. Integration tests exercise additive
  migration, zero charges, stable/changed/added/missing users, drift, retries,
  and immutable snapshots. Unit tests cover endpoint authorization and API
  field allowlisting.
- A new **additive migration** requires a separate explicit Staging
  compatibility-hash approval. A protected release must *fail closed* until
  the Owner/approved release process updates `compatible-migrations.json` from
  the reviewed candidate. Do not disable the preflight or infer that Merge
  has deployed this migration. Never apply this Staging exception to production.

## Not in scope

Actual day-one cutoff, reconstructing historical Create or payment, nightly
tariff calculations, Next Plan posting, zero-charge exceptions for Owner test
accounts, automatic daily source reconciliation, report delivery, altering
PasarGuard users, direct PasarGuard DB access or production secrets.

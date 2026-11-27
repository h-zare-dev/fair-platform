# FP-005 — Staging shadow test and Owner acceptance

## Owner's 2026-11-21 ingestion-only replay test

The Owner requested **only the verified 30-day private legacy export** before
enabling any second live webhook. This extends the disposable Staging test
without changing the night-only financial rules. The one exact gzip SHA-256
`fa845d0a2276e65ff7ca4c77fc253c289309541ed3367d752ab3ee4af190e242`
contains 15,914 batches and 64,135 children. The archive itself and all
identities remain private: do not commit or upload them to Actions artifacts.

After a healthy protected deployment, the Owner can select the existing `.gz`
file using **Dashboard → ورود آرشیو ۳۰روزهٔ ربات قبلی**. The Owner-authenticated
CSRF-protected browser importer validates the complete compressed SHA-256 and
child counts, chunks JSONL records below Caddy's existing webhook request size,
and inserts encrypted durable inbox batches under source `replay-30d`. Repeats
are idempotent. The normalization worker drains the queue in bounded batches.
Use the dashboard's **آرشیو واقعی ۳۰روزه** range (fixed at the approved export
cutoff, source automatically set to `replay-30d`) to verify the full 30-day
intake and processing without losing the earliest replay date as time passes.
Re-run the same file after an interruption; it
must not double-insert previously accepted batches.

`replay-30d` is **not** source `primary`: the NightlyShadow closer only reads
`primary`, so this replay generates no shadow accounting, no invoices and no
Telegram deliveries. Do not turn on the PasarGuard second webhook during this
replay test. The normal webhook still requires its distinct secret; the upload
branch requires an Owner session + same-origin CSRF, never an anonymous bearer
value. This is one historical upload, **not** a general arbitrary JSON import.

**Owner decision (2026-11-20):** use existing `panel.fairisfair.ir` public
test server, **without backup or restore**. Data may be lost. No legacy-bot
modifications, no financial settlement, no real invoices, no Telegram messages.
Only the Owner marks PR #89 Ready and merges it.

## What the implementation does

1. Authenticates a *second* PasarGuard webhook destination with a distinct
   `x-webhook-secret`; API key access for the Admin directory is **not** reused
   as the webhook secret. Deny-by-default if the secret is not mounted.
2. Encrypts each accepted webhook batch and commits it before acknowledging;
   asynchronously normalizes child events and retains exact bytes,
   created/expiry/edit timestamps, on-hold seconds and nullable Actor.
   Repeated deliveries stay idempotent. Raw ciphertext expires after 14 days
   (only successfully processed/permanently failed batches are purged).
   The server-side Owner runtime database role now needs to read encrypted
   inbox columns and normalized identifiers for processing. Its SQL UPDATE
   grants are limited to receipt/retry metadata, **not** core account size,
   source timestamps or usernames. The browser never receives raw ciphertext.
3. At **02:10** local `FAIR_TIME_ZONE` (default `Asia/Tehran`) and only during
   the nightly window, closes eligible *previous* days for `user_created`
   operations. No daytime calculation. A frozen immutable daily SHADOW result
   uses the group membership audit at local midnight, assignment creation
   cutoff and exact fixed `(bytes, integer days)` match. Per-GiB uses integer
   bytes and final Toman CEIL; direct Admin rules have matching precedence.
   Only the newly authenticated source `primary` is eligible for this Staging
   Shadow run; the existing `synthetic` dashboard seed is never billed, even
   in Shadow.
4. Sends unprovable duration, unknown package, same-day correction and
   duplicated/conflicting sources to typed ambiguity rows. Holds only that
   Admin/day. Later Admin/days proceed. Late events after a sealed Shadow day
   appear separately; the original day never changes.
5. Lists cases in `/accounting/ambiguities`, isolated from technical webhook
   errors in the main dashboard. This route requires Owner authentication and
   never returns customer usernames or raw bodies. This phase does **not**
   finalize accounting reports or reconcile FP-006/007 updates/resets.

## One-time protected operator sequence — no automated host config mutation

The existing staging release system correctly blocks changed Compose,
Caddy, database migrations and PostgreSQL image hashes until manual approval.
Do **not** bypass those gates or re-run unrelated legacy reconciliation jobs.

1. Generate a different, long random secret locally. Put it in the GitHub
   `staging-bootstrap` **Environment secret** named
   `PASARGUARD_WEBHOOK_SECRET` (32–128 ASCII letters/digits/_/-); never paste
   the value into Git, a PR discussion, screenshots, or logs.
2. After Owner merges PR #89 and its **containers/publish** checks succeed,
   visit GitHub Actions → **Staging FP-005 shadow ingestion approval
   (Owner only)** → Run workflow on `development`. Type the exact confirmation
   `APPROVE_FP005_SHADOW_STAGING`.
3. The Owner-only workflow checks the exact before/after Compose+Caddy bytes,
   both new migration code hashes (preserving all old hashes), pinned SSH
   identity, candidate image provenance, the existing PostgreSQL identity,
   and explicitly the **package-only PostgreSQL security patch**. It installs
   only the root-owned independent secret and approval metadata. **It does
   not run migrations, replace PostgreSQL, restart apps or change PasarGuard.**
4. Re-run the **Deploy** job of the latest protected `development` CI run. It
   remains responsible for migrations, image transition, app startup, health,
   smoke, journal and rollback checks. If the operator step fails, stop and
   inspect its fixed failure code; do not disable CI or force deploy.
5. After a successful staging deployment, in the existing PasarGuard panel
   **keep Webhook #1 unchanged** (`http://127.0.0.1:8888/webhook` legacy bot).
   Add **Webhook #2** with URL
   `https://panel.fairisfair.ir/api/v1/owner/webhook/pasarguard` and the
   **same new** independent webhook secret from step 1. Do not change global
   retry/timeout settings as part of this experiment.
6. Generate one harmless account-create test in PasarGuard, then confirm its
   source event appears in the Fair dashboard. Confirm the legacy bot also
   processes that event. Check package pricing separately **after 02:10 the
   following local day**, not on webhook receipt. Use Fair source `primary`
   (not the former `synthetic` sample) for test package/group assignments.
7. Test a missing/unmatched duration: it must appear under Accounting
   Ambiguities, not as a zero-cost invoice. Verify no Telegram report was
   sent and no prior Shadow day changed. Observe both webhook destinations
   for independent retries and lag before relying on them.

### Explicit boundaries

- Private 30-day archive is **not** uploaded to public Git. Existing offline
  replay is a separate test; the live second destination does not depend on it.
- No automatic historical baseline reconstruction, Update/Reset charge,
  Telegram report, weekly/monthly aggregation or Live ledger.
- Changing `FAIR_TIME_ZONE` once any Shadow day is recorded fails closed
  pending a separate planned migration. Source timestamps govern days; receipt
  timestamps are diagnostic only.
- Staging has **no backup/restore** per Owner direction. This exception is
  for disposable testing, never real production billing.

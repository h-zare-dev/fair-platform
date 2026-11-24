# FP-006/007 — Settings reseed and historical SHADOW trial: Owner acceptance

**Scope:** combined draft PR #114, 2026-11-24. Staging only. No real PasarGuard
balances, no active second webhook, no LIVE ledger, no invoice, no report send.

## Frozen policy

- 25 Owner-entered, positive, unique package shapes/prices from source
  `primary`, assigned to one group with exactly 153 members. GiB means
  `1_073_741_824` bytes, money is integer Toman; **never** estimate prices
  from a fallback rate or silently map historical admin IDs to live IDs.
- Source: only validated `replay-30d`, with **15,914** normalized batches and
  **64,135** child events; snapshots for 90/180 days are not presumed available.
- Correlation: for one account and one business day, deterministic pairs of
  alternating `user_updated`/`data_usage_reset` up to a source-time gap of
  **600 seconds**. Both orders, equal source timestamps and multi-renewal
  chains need regression tests. Only the new `Update` shape is priced on a
  combined renewal, even if `Reset` carries the prior duration.
- `FAIR_SHADOW_DELETE_CREDIT_ENABLED=false` by default. When `true`, Delete
  credits **the full most recent provable charge** without elapsed-day limit;
  duplicate Delete does not produce repeated credit. The setting is read on
  API startup and frozen in each new trial run. No dashboard switch exists.
- Unpriced shape, uncertain duration, ambiguous correlation, unverified
  source or unsupported Next Plan blocks the **whole admin/business-day**.
  That day's candidate charges do not enter posted SHADOW totals. An
  unposted referenced purchase cannot generate a posted credit.
- Opening setup reseed replaces the selected generation, with immutable
  earlier-run audit evidence preserved. Reimport is explicitly read-only:
  neither opening debt nor credit is created.

## 1. Before Owner merges (local/CI)

1. TypeScript API/web/tests compile; ESLint and Prettier pass on changed files.
2. All existing unit tests plus newly added two-order renewal, deletion,
   ambiguous, authorization and exact-trial tests pass.
3. PostgreSQL integration tests exercise both ENV policies, immutable rows,
   Owner/CSRF, idempotent reseed, and existing financial table isolation.
4. Protected Staging approval workflow must validate **only** the two new
   additive migrations and the new Compose env mapping; no unexpected Compose
   configuration or migration is automatically approved.
5. The PR remains Owner-controlled for review/Ready/merge. CI success alone
   is not evidence that the private full archive calculation passed.

## 2. After Owner merges and separately authorizes the Staging release

1. Review deployment/health of `/settings/initialization` and the Operations
   historical SHADOW journal panel. Apply any required protected migration
   approval through the Owner-only manual workflow; do not bypass its host
   and source-hash checks. Keep the second webhook disabled.
2. With **ENV false**, in Settings select **«بازنشانی و دریافت مجدد»**.
   Verify new generation/run, old evidence retained, no event/group/package
   deletion. Confirm successful two-pass scan even if source user counts
   increase/decrease during scanning. A second click/retry must not create
   duplicate generations. Verify a post-cutover lock rejects reseed (when a
   real cutover lock exists; do not fake financial cutover here).
3. In Operations select **«اجرای آزمون آفلاین»**. Wait until `COMPLETE`.
   Validate `source=replay-30d`, `postingScope=SHADOW`, `liveBalanceMutated=false`,
   `eventCount=64135`; inspect charged, held, ignored, and credited breakdowns
   separately. Compare Create and combined Update/Reset aggregates with the
   established FP-005 and FP-006/007 read-only preview, explaining differences
   (not assuming an automatic one-to-one correspondence).
4. Check that no credit appears for a deletion in the ENV-off run, and that
   no real admin balance, archived webhook, prior snapshot, or `fair_shadow_*`
   nightly ledger has changed.
5. If Owner wants the ENV-on comparison, change **only the protected runtime
   environment** to `FAIR_SHADOW_DELETE_CREDIT_ENABLED=true` and restart the
   API through the normal Owner-controlled Staging procedure. Re-run the
   trial, **without re-importing or deleting existing evidence**. Confirm
   new Delete credits are linked to the latest provable purchase, previous
   run remains unmodified, and doubtful source days remain held. Revert ENV
   to `false` unless Owner explicitly chooses otherwise.
6. Verify same-day and later-day deletions; out-of-order Reset+Update;
   30→60-day package change; multi-renewal chains; 0.5-GiB/2-day exact
   trial; unproven Create/Update/Reset; duplicates and unknown shapes.
   Record any remaining hold types and affected admin/day before claiming
   reconciliation is complete.

## 3. Evidence and go/no-go

| Gate | Acceptable evidence | Status before Owner merge |
| --- | --- | --- |
| Code safety | Unit/CI, typecheck, lint, migrations, auth/CSRF, invariant tests | Local test evidence in PR |
| Opening reseed | New selected generation after reset, old runs immutable, no opening money | Pending Staging confirmation |
| 30-day archive | All 64,135 events assessed; explicit hold and money totals in Owner UI | Pending Staging replay |
| Delete ENV off/on | Two separate immutable runs, credit only enabled run | Pending Staging toggle test |
| Real balance isolation | No mutation of LIVE balances / main nightly ledger | Must inspect Staging before and after |
| Financial cutover | New webhook, identity mapping, finality, reporting, delivery, reconciliation | **Not authorized / not complete** |

If a required archive, package price or membership is missing, the trial
must be rejected, not padded with estimates. If a run fails, retain its
bounded failure code and immutability; investigate on a fresh run after a
reviewed fix. Do not declare LIVE-ready merely because a hypothetical
total is nonzero or the first 30-day SHADOW run completes.

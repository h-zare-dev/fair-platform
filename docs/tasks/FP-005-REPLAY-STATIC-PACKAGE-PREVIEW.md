# FP-005 — Owner-approved 30-day static package replay preview

## Owner authorization (2026-11-21)

The Owner explicitly requested an immediate code implementation and numeric test
for **25** (not 28) fixed packages, all **153** PasarGuard administrators, and the
already verified 30-day legacy-bot archive. The Owner attests that the existing
package sizes, durations and prices have not changed for approximately six
months. These prices are an assumption for this **hypothetical replay**, not
independent proof of historical tariff or membership effective dates.

This narrowly extends FP-005's read-only test. It does **not** authorize FP-006
Update/Baseline or FP-007 Reset/Renewal accounting, a live ledger, any financial
posting, reports, Telegram delivery, production deployment, or new integrations.

## Implementation contract

1. Owner-authenticated dashboard action and `GET
   /api/v1/owner/operations/accounting/replay-preview` only. No writes, no
   mutation of historic Shadow days, no modifications to the nightly runner.
2. Read the existing fixed-price **catalog, memberships and assignments** on
   the actual `primary` PasarGuard source. Read normalized events and ingestion
   status exclusively on the segregated `replay-30d` source. Never seed,
   overwrite or invent the Owner's 25 prices. No public/private raw archive or
   PasarGuard API credentials in code or tests.
3. Fail closed before showing any subtotal unless exactly 25 valid, distinct
   package shapes are assigned to **one** group of exactly 153 distinct admins,
   with no direct-admin/per-GiB override assignments. The archive must have
   exactly 15,914 completed normalized batches and 64,135 input children;
   permanent batch failures also block calculation. If absent, report the
   configuration or ingestion gap; **never substitute a zero tariff**.
4. Classify only `user_created`, matching exact GiB-derived integer bytes and
   positive integral duration days to a fixed-price package; add integer Toman
   only for unambiguous `READY_FOR_ACCOUNTING` events. Repeated same-day
   create/delete of a username, even across admins, is a correction held for
   review. Missing duration, unmatched shape and bad correlation are held.
5. Display distinct `Create` subtotal, per-package size/duration/fixed-price
   aggregates, priced/held Create counts, typed held reasons, total normalized
   actions, and unclassified non-Create count.
   Explicitly mark **`completeAccounting: false` and `postingScope: NONE`**;
   the partial subtotal is **not a debt, invoice, settlement or statement of
   correctness of all 30-day events**.
6. Return aggregate counts and reasons only. Never return a username, token,
   admin identifier, unencrypted payload, subscription URL or event body.
   Keep selection bounded. Read-only data may be incomplete until the Staging
   deploy and catalog/153-membership setup are verified by the Owner.

## Test and acceptance

- Synthetic 25-package/153-admin matrix with exact amount, invalid size,
  duration, correlation, multiple same-day actions and other event types.
- Reject 24 packages, one unassigned admin, duplicate package shapes, admin
  overrides and incomplete/permanently failed archive batches.
- Integer Toman stress with price above JavaScript safe integer precision.
- Verify the reader uses `primary` for pricing and `replay-30d` for events;
  SQL is read-only and bounded; HTTP route requires Owner authentication.
- After CI passes and the **human Owner** merges/deploys the Draft PR, run
  the dashboard preview. Compare the resulting held counts and amounts with
  the trusted legacy-bot baseline. **Do not certify full accounting** until
  FP-006/FP-007 and independent reconciliation have been implemented.

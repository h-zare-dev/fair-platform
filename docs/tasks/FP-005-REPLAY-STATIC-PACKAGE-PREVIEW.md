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

## Staging regression follow-up (Owner screenshot, 2026-11-21)

After PR #93 merged, the UI rendered but the first button press returned a
non-OK HTTP response. The actual server-side status/log has not yet been
obtained. One plausible cause is an unbounded 64,135-row SELECT facing the
existing 5-second PostgreSQL statement timeout. Preserve the same pricing
semantics while moving Create shape/status/count and same-local-day
create/delete correlation aggregation into read-only PostgreSQL queries.
Read only bounded aggregate result sets; never materialize the entire replay
in the Owner API. A local Gregorian date after `AT TIME ZONE` has exactly
the same daily boundaries as the local Jalali date for same-day correlation.
Report HTTP status for future failures without exposing backend exceptions.
Test both synthetic parity and the actual PostgreSQL grouping query. If this
does not resolve Staging, obtain sanitized Owner-only diagnostics before
assuming a different root cause. No posting or permission expansion.

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

## Staging identity mismatch follow-up (Owner request, 2026-11-22)

After the Owner entered 25 positive fixed prices at 2,000 Toman/GiB and
bootstrapped all 153 current PasarGuard administrators through one group,
Staging reported complete catalog and archive coverage but held **all 13,530
Create events** as `ADMIN_MEMBERSHIP_MISSING`. The historical `replay-30d`
source and present-day `primary` admin directory are separate identity datasets;
the observed mismatch is **not proof** that any specific replay admin belongs
to the group. No automatic username mapping or identity rewrite is permitted.

The Owner requested a corrective Draft PR and a dashboard accounting test.
Preserve the existing fail-closed **identity-verified** quote unchanged, and
present a **second, explicitly conditional** calculation assuming that every
historical replay admin had the one common group and those 25 unchanged prices.
This is for numerical testing of exact Create package shape/duration only;
never mix its totals with verified totals. Reveal aggregate matched/unmatched
Create counts (not identities), separate held reasons and per-package sums.
When catalog or archive coverage is incomplete, the conditional subtotal must
remain null. Both modes remain Owner-only, read-only, non-posting and not a
financial statement. Actual historical admin identity reconciliation is
still unresolved until separately verified; do not silently label this new
scenario as an authoritative accounting result.

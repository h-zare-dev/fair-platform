# FP-006 + FP-007 — Owner-approved read-only combined Update/Reset experiment

## Scope and Owner approval (2026-11-22)

The Owner explicitly requested FP-006 (Update and baseline) and FP-007
(Reset and renewal) together, because a verified renewal can generate both
actions. The Owner authorizes extensive tests using disposable Staging data and
requested a Draft PR for personal review/merge. The already entered **25**
unchanged fixed packages, **153** administrators in one Fair-local group, and
the segregated 30-day archive are the only allowed inputs to this experiment.

This is an **aggregate-only, Owner-attested hypothetical historical preview**,
not the final FP-006/FP-007 financial implementation. It does not establish
historical Billing Admin identity, baseline provenance, group-at-day-end
history, actual Next Plan activation, delivery, settlement, or live financial
posting. The approved target nightly accounting remains a subsequent milestone.

## Implementation contract

1. An Owner-session-only `GET
   /api/v1/owner/operations/accounting/replay-update-reset-preview` and
   Persian dashboard action run only read-only queries. Accept no request
   parameters; use `primary` exclusively for the existing 25 package prices,
   assignments and 153 memberships, and `replay-30d` for normalized events.
   Do not seed tariffs, create charges, mutate historical events, emit reports,
   change Shadow days or create a ledger obligation.
2. Preserve the existing FP-005 strict Create quote and its clearly separate,
   non-posting Owner-attested Create scenario. Update/Reset is a **separate**
   hypothetical subtotal; do not combine the two into a debt or statement.
   Fail closed if the 25-package/153-admin matrix or expected normalized
   archive counts are incomplete. Return `postingScope: NONE` and
   `completeAccounting: false`.
3. Correlate Update and Reset on the same stable **Billing Admin + source user
   ID** within the Owner-configured source-time window (default 120 seconds,
   allowed 1–600), independently of action order. A candidate with multiple
   plausible partners is held `AMBIGUOUS_CORRELATION`. A generic unchanged
   Update does not itself evidence a renewal: the Reset is treated as its own
   operation and the unchanged Update has no fee. Unverified prior state or
   correlation is held, never charged twice.
4. Exactly one evidenced Update+Reset pair is one renewal at the **final**
   package shape `(bytes, duration_days)`. Standalone verified resets charge
   their full resulting package. Verified independent Update increases charge
   **only the positive byte delta**, exactly matching a fixed package and
   known integer duration; decreases/unchanged Updates have no charge/refund.
   A separate Next Plan setting is non-billable. Actual Next Plan activation
   is out of scope until supported evidence exists.
5. Hold incomplete duration, unknown prior state for independent Updates,
   unlimited traffic, source status requiring review, unmatched fixed package,
   nonunique pairing and tied timestamps. No guessed duration, price, fallback,
   identity mapping, zero-charge substitute or floating-point money. Pricing
   uses signed-safe integer Toman and exact source bytes.
6. SQL returns **only grouped shape, status, previous-shape, correlation
   flags and counts**. Never return a source event ID, username, Billing Admin
   ID, raw payload, token or other private historical identifier to the API
   response. Bound groups and work from the normalized immutable archive.

## Verification and acceptance

- Unit cases for the precise fixed-package amount, independent increase,
  decrease, unchanged Update, unique renewal, no-double billing, missing
  prior state/duration/price, ambiguous counterpart and incomplete matrix.
- Actual PostgreSQL 17 tests cover group-by/source-time SQL, order independence,
  generic unchanged Update near Reset, ambiguous multi-update, missing initial
  snapshot, and equal external user IDs owned by **different** Billing Admins.
- API session authorization, invalid query rejection, non-posting output,
  TypeScript/build/lint and Persian dashboard regression are required.
- Following the **human Owner** merge/deploy to Staging, re-run the panel
  preview, verify config/archive coverage and compare per-package sums and
  held reasons against Owner-only aggregates. A successful preview **does not
  approve live financial posting** or certify production accounting correctness.

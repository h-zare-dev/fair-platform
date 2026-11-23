# FP-006/007 — Owner-approved archive-boundary Reset/Update reconciliation

## Authorization and observation (2026-11-23)

The Owner approved another evidence-based, read-only experiment focused on
`AMBIGUOUS_CORRELATION` in the 30-day Staging replay. Existing duration
conflicts, missing durations and missing predecessors are deliberately
**out of scope**. The existing fixed prices and admin group
group and non-posting Owner-only API remain unchanged.

An aggregate-only offline inspection using the existing source normalizer
reproduced the Owner-observed Staging counts exactly. It identified many
uniquely adjacent Reset-then-Update pairs rejected solely because the Reset
has no prior event in this **bounded archive**. Same-timestamp cases cannot
establish order. Individual counts and all source identities remain private.
This is **not historical ownership/baseline proof**.

## Narrow matching rule

For a new *hypothetical* Reset+Update match with no prior archive event for
the Reset, require **all** of the following inside the existing 1–600 second
Owner-configured source-time window:

1. Exact same stable `(billing_admin_id, external_user_id)` and **exactly one**
   candidate Update per Reset and one Reset per Update, counting *all*
   candidates before any other filter. No greedy nearest-neighbor matching.
2. Reset is the first recorded event for this stable identity in the archive;
   the Update's **immediate** source-timeline predecessor is this exact Reset.
   Reset source timestamp must be strictly earlier; ties and reversed order
   remain held. Never synthesize a previous state or price an isolated Update.
3. Both records must be `READY_FOR_ACCOUNTING`, and the Update must corroborate
   the Reset's exact bytes as its preceding recorded state. Existing status,
   duration, unlimited and exact fixed-package checks remain fail-closed.
4. If Reset and subsequent Update have identical package bytes, classify as
   **one** `RESET_WITH_UPDATE_CONTEXT` with the Update duration only when the
   Reset duration is absent or equal. Contradictory durations are held.
   If bytes differ, classify as **one** `RENEWAL` priced at the final Update
   package and its independently sourced duration. Never count two charges.
5. Existing fully evidenced pair matching, separate Update, standalone Reset,
   Create quote and all financial posting/reporting behavior stay unchanged.

Expose only aggregate `boundaryFirstPairCount` and
`pricedBoundaryFirstPairCount` to the authenticated Persian preview. Never
return source identifiers, usernames, individual timestamps or raw records.
`postingScope: NONE`, `completeAccounting: false` always remain.

## Acceptance

- Synthetic pure/unit and PostgreSQL tests cover unique same/changed shape,
  exact-once charge, a first Reset with missing duration corroborated by Update,
  missing/contradictory duration, same-time tie, an intervening event,
  candidate fan-out, and same user ID belonging to another Billing Admin.
- API authorization, typecheck, lint, UI disclosure and negative posting checks.
- Owner merges Draft PR personally and re-runs Owner-only Staging preview;
  compare exact aggregate reductions and unchanged pre-existing holds.
- No new identity mapping, guessed historical baseline, nightly posting,
  ledger mutation, delivery or production authorization is granted here.

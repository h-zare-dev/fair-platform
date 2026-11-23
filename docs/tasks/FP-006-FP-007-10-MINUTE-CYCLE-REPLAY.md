# FP-006/007 — Owner-approved 10-minute source-time cycle replay correction

## Scope and approval (2026-11-23)

The Owner rejects short correlation cutoffs of 1/20/120 seconds, approves
examining up to 5–10 minutes, order-independent Update/Reset matching and
end-of-local-day **future** settlement, and requests a new Draft PR and a
30-day private archive test. This task authorizes a **read-only Owner-only
hypothetical replay correction** with a default 600-second source-time window;
it does **not** authorize a live FP-006/007 charge, nightly settlement
implementation, webhook change, identity reconciliation or production access.
Only the human Owner may mark Ready or merge.

## Bounded deterministic correlation

1. Use the stable pair `(billing_admin_id, external_user_id)` within the
   existing segregated replay source. Order by **source** `enqueued_at` (never
   webhook receipt); a second webhook, backlog or delayed HTTP delivery does
   not change these source timestamps. Source-time ties fail closed. The
   Owner-configured window remains 1–600 seconds; its default is now **600**.
2. In each configured `FAIR_TIME_ZONE` local day, form chronological chains of
   *consecutive source-timeline* Update/Reset actions. Any unrelated action,
   source-time tie, local-day boundary or gap exceeding the configured window
   separates chains. Never correlate on a matching username or date alone.
3. For a strictly ordered, **even-sized fully alternating** chain, the only
   adjacent non-overlapping complete pairing is `(1,2), (3,4), ...`.
   Either Reset→Update or Update→Reset may be first. Two true renewals in a
   day produce two separate candidate operations, never a single charge.
   Odd, non-alternating or otherwise nonunique chains cannot be greedily
   split; their unmatched actions with an opposing action on the **same local
   day** remain `AMBIGUOUS_CORRELATION`, even if farther than 600 seconds
   apart. No timing proximity alone supplies missing
   status, package, duration, historical identity or predecessor evidence.
4. Preserve the current source-snapshot readiness, no-unlimited and exact
   package-price checks. A Reset with an unchanged Update supports one
   Reset charge only with sufficient prior/source evidence, not two charges.
   When Reset precedes Update and the Reset's exact bytes and duration equal
   its **verified immediate predecessor**, a later Update with the same bytes
   but a new explicit duration is a legitimate duration-changing renewal.
   Charge the **final Update** exact `(bytes, days)` once, not the old Reset
   duration. If the old state or transition is not proved, keep
   `DURATION_CONFLICT`. Changed bytes use the later verified state. Never
   infer duration from a timestamp without a separately approved rule.
5. The result remains aggregated inside PostgreSQL; no historic event/user/
   admin IDs or private timestamps leave SQL. Preserve the already-matched
   events exactly once, the 25 explicit fixed prices, 153 current memberships
   as an **attested what-if only**, separate FP-005 Create quote, and
   `postingScope: NONE`, `completeAccounting: false`. No ledger/report writes.
6. End-of-day classification and settlement, grace/lateness handling and
   frozen group-at-day-close price are future milestones; this PR **only**
   previews local-day-aware correlation over the complete archive. A 600-second
   correlation window is **not** a 600-second HTTP delivery deadline.

## Evidence and acceptance

- Real 30-day private offline analysis (never commit identifiers or raw
  fixtures) reproduced 202 ambiguous action sides, 64 duration conflicts,
  25 missing durations and 13 missing predecessors in the previous preview.
  The proposed deterministic 600-second chain algorithm forecasts **3**
  ambiguous action sides, **0** duration conflicts, **24** missing durations
  and **13** missing predecessors, or **40 total** held operations. This is
  a forecast until the updated SQL is run against PostgreSQL/Staging.
- Synthetic tests: 5/10-minute boundary, >600 seconds, Reset-first and
  Update-first, consecutive independent renewals, odd/non-alternating chains,
  intervening event, equal-source-time tie, midnight boundary, same user ID
  under different Billing Admins, duration 30→60 proven by prior state,
  unsupported duration mismatch, missing state/status/package, and no double
  accounting. Validate the real PostgreSQL grouping, Owner-only route,
  aggregate-only output, local timezone and unchanged non-posting guard.
- Owner personally merges a Draft PR and re-runs the Staging Owner-only
  read-only preview; compare exact grouped holds/counts to the offline
  prediction and investigate discrepancies before any financial activation.

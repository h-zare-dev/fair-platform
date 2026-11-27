# FP-005 — Owner-approved one-shot fixed catalog bootstrap (Staging)

## Owner authorization and missing data

On 2026-11-22 the Owner requested to finish all steps as one operation after
the 30-day preview successfully ingested 15,914 batches / 64,135 normalized
events, but returned **0 packages, 0 group assignments, 0 memberships** on
`primary`; 13,530 Create events were held as `CATALOG_COVERAGE_INCOMPLETE`.
The Owner previously approved exactly 25 fixed package shapes (6×30-day,
9×60-day, 9×90-day, 1×2-day test) shared by all 153 PasarGuard admins through
one group, not 3,825 per-admin assignments.

**The 25 real historical prices are not available.** A previously mentioned
2,000 Toman/GiB was explicitly a temporary trial rate and is not proof of
the historical fixed prices. Never silently convert it to fixed prices, seed
zeros or guess. The UI must require 25 explicit positive integer Toman
amounts before enabling any write.

## Narrow implementation scope

1. Add an Owner-authenticated same-origin CSRF-protected POST endpoint for a
   **single atomic, one-time** setup on `primary` only. The handler retrieves
   *all* admin IDs from the configured read-only PasarGuard admin directory,
   bounded to exactly 153 unique IDs in 4 validated pages of ≤50; unavailable,
   changed or incomplete directories fail closed before PostgreSQL writes.
2. Use the approved 25 canonical name/size (integer GiB bytes)/duration
   shapes, not user-entered size or duration. Validate exact 25 distinct names
   with a positive, signed-bigint-safe integer Toman price each. Reject extra,
   duplicated or missing rows, unknown names, and unauthorized source.
3. In one SERIALIZABLE PostgreSQL transaction, lock the bootstrap operation,
   ensure the existing `primary` group/catalog/membership/assignment tables
   are **completely empty** (otherwise refuse and preserve all existing data),
   create one group, 25 immutable package entries, 153 membership rows and
   audit entries, and 25 fixed group assignments for the current local day.
   No partial state on any failure. Never touch `replay-30d` or legacy bot.
4. Return only aggregate counts. Show the Owner the full 25-row price entry
   form, separate submit button and explicit confirmation. Never auto-submit.
   Unset prices block submission; preexisting setup blocks retries instead of
   duplicating, overwriting or re-pricing historical records.
5. No ledger, posting, settlement, Telegram, real charges, production access,
   direct-admin override, tariff history rewrite or FP-006/007 semantics.
   After Owner merges/deploys this separate Draft PR, enters verified prices
   and confirms the single operation, the existing 30-day Create-only preview
   can be re-run. Only the Owner may mark Ready or merge.

## Test acceptance

- Exactly 25 canonical distinct package shapes and prices, correct group
  membership 153 and group assignments 25; all integer Toman.
- Missing/duplicate/zero/out-of-range prices, directory count mismatch,
  duplicate IDs, unexpected source or preexisting catalog must fail closed.
- One database transaction; injected failure rolls back packages, group,
  memberships and audit. Concurrent/bootstrap retry cannot overwrite state.
- Owner session, CSRF and JSON-only for API; no secrets or user-level payload
  in the response; 30-day preview is unchanged and remains non-posting.

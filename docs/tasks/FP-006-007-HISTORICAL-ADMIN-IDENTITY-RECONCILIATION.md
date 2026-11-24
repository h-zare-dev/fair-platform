# Historical replay identity reconciliation and explicit Jalali report periods

**Owner request (2026-11-24):** the 30-day SHADOW audit must show verifiable
PasarGuard Billing Admin names in per-admin daily/weekly/monthly drill-downs,
not merely opaque `anon-*` replay aliases. Weeks must have visible start/end
dates; monthly reports must identify the Persian month and year.

## Confirmed source boundaries

- `primary` is the live **read-only** `/api/admins/simple` PasarGuard directory,
  with current ID and username. No PasarGuard database access or writes.
- `replay-30d` is the separate historical source. Its original exporter
  pseudonymized IDs and names using a secret kept outside this public repo.
  The normalized `billing_admin_username` therefore contains aliases such as
  `anon-*`, not the current names. It is not a reporting-formatting bug.
- Comparing arbitrary historical integer IDs with current IDs, account names,
  row ordering, amount totals or similarly named users is **not** identity
  proof. Do not attach one person's debt to another person's current name.
- Billing Admin is the debt owner; Actor Admin is separate.

## Implemented safe presentation correction

- An `anon-*` Billing Admin name is explicitly labeled pseudonymized, never
  `VERIFIED_IN_ARCHIVE` or represented as a real current administrator.
- Weekly rows expose **both** the configured starting weekday and the ending
  weekday with their exact Jalali dates. They remain derived from the existing
  `FAIR_REPORT_WEEK_START_DAY` grouping, without changing a booked amount.
- Monthly rows expose the Persian month name and Jalali year and keep the
  exact start/end dates from the server. No new date arithmetic or ledger
  writes are performed in the UI.

## Reconciliation work requiring private provenance (not yet approved/run)

Before implementing or importing a mapping, the Owner must establish whether
the original `fair_replay_export_v2.py` and HMAC identity key still exist on
the legacy bot server, or whether a source-verified correspondence file exists.
Never request or upload the HMAC key, raw webhook input, user records or private
mapping to GitHub. If neither source is available, offer a distinct **Owner-
attested** manual association path; never label it cryptographically verified.

Acceptance of any mapping implementation will require:

1. One-to-one proof scoped to the exact replay-export identity-key generation;
   reject collisions, changed identity epochs, missing/unrecognized aliases,
   conflicting IDs and partial proofs without assigning a current name.
2. Reconciliation coverage counts (`verified`, `unmatched`, `conflicting`) and
   per-row source/status visible to Owner. An unmatched row stays searchable by
   archived ID and clearly has **no current verified name**.
3. Source-verifiable mapping preserved separately from immutable historical
   financial calculations. Never reprice, repost, modify events or activate
   a webhook. Do not print private identifiers in CI, PR text or artifacts.
4. Synthetic adversarial tests plus bounded, Owner-controlled private Staging
   validation before claiming that 153 names have been recovered.

**Status:** Calendar and truthful pseudonym display implemented in a Draft
PR. Identity **mapping is blocked on private export provenance** and must not
be described as completed. The Owner retains Ready, Merge and release control.

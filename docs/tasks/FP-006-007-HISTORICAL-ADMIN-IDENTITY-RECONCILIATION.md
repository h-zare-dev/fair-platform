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

## Reconciliation work requiring private provenance (source step completed)

The Owner ran a private, read-only identity-sidecar export on the legacy bot
server on 2026-11-24. The exporter checked its original source/script and
HMAC key locally, generated a separate private map, and reported
`VERIFIED_SOURCE_REPLAY_MATCH` for the original 64,135-event replay. The
private sidecar remains on the legacy server, never in this repository.
The original script/HMAC key must remain on that server; do not ship either.

### Owner-approved scope for this implementation PR

- Implement **offline, operator-executed, private CLI import only**; no public
  mapping upload HTTP route, and no public GitHub artifact/secret/fixture.
  The migration adds source-scoped, report-only identity metadata tables.
- Require source exporter SHA allowlist, manifest proof fields, exact gzip
  checksum, expected 30-day 64,135 event count, one-to-one role-specific
  original/anonymous ID mapping, no duplicate/conflicting aliases, and a
  transactionally unchanged archive event count before committing an import.
- Match an archived Billing Admin and account by **both** archived numeric ID
  and archived username for each event. Show its *historical original name* and
  distinct original ID with `SOURCE_VERIFIED_HISTORICAL` when proven. Do not
  silently match historical original IDs to the current PasarGuard directory.
  Missing, partial or conflicting names stay visibly unresolved.
- One import per replay source/epoch; identical repeat is idempotent, different
  map checksum fails closed. No Delete, Reset, replacement, change to any
  historical event, price, ledger, account balance, or live webhook route.
- UI clean-up is **only** on dashboard: hide obsolete 30-day import/Create/
  Update-Reset previews, put the one-shot package bootstrap in Settings /
  Initialization, and keep the SHADOW ledger re-run in Reports behind a
  clearly marked advanced control. Underlying archived data and API remain.
- Show import coverage on the Owner-only reports page and preserve archive ID
  for all drill-down filter keys. Query responses are non-cacheable and
  inaccessible without Owner session; do not put raw mapping in logs.

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

The source-side evidence saw **132 historical Billing Admin IDs**, not 153
current active admins. An import proves historical source identity, not
membership in the current 153-admin directory. A missing `actor_admin` source
field in 6,570 events does not by itself affect Billing Admin proof.

**Private staging acceptance after Owner merge:** follow the separate
`docs/deployment/PRIVATE-REPLAY-IDENTITY-IMPORT.md` runbook. Until the Owner
executes it and verifies report coverage, all real historical names remain
unavailable on Staging. No live accounting authorization is implied.

**Status:** Calendar and truthful pseudonym UI were merged previously. The
new private CLI importer and dashboard clean-up are proposed in a **Draft PR**;
the private actual Staging import and its acceptance remain Owner-controlled.

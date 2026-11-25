# Owner reports — all-admin period rollups, named filters, and calendar selector

**Owner instruction:** 2026-11-25. One cohesive Draft PR against `development`;
only the human Owner marks Ready, merges, or authorizes a Staging release.

## Scope approved by the Owner

1. A fresh daily, weekly or monthly report has **no administrator restriction**.
   Exactly one row per calendar day/week/month sums every Billing Admin's
   immutable SHADOW daily records in the chosen completed run. Selecting one
   Billing Admin changes those same rows to the selected admin's own totals;
   clearing the selection restores all-admin totals. The existing Owner-only
   run selector still isolates different historical replays: combining runs
   would double-count evidence and is not authorized.
2. Default to **all administrators** also for booked operation details,
   ambiguities, approved unpriced manual operations and unbooked candidates.
   Keep search, reason, kind, date and bounded pagination. Show a searchable
   **name-first** administrator selector sourced from the selected run's
   verified identities, not a field requiring manual numeric ID entry. If an
   archived name is absent, conflicting or pseudonymized, explicitly label it
   unverified and retain the ID only as a technical fallback. Never infer an
   identity by joining an archive ID to today's PasarGuard admin directory.
3. Report period rows display booked amount, credits, ready subtotal, GiB,
   operations and held days for the selected scope. In global mode, the
   observed/ready/pending counters are clearly **admin-days**: multiple admins
   can have different outcomes on the same civil day. A period with any held
   admin-day has **no final total**; the sum of verified ready entries remains
   separately visible. Keep the financial amounts and journal immutable.
4. All report date-range filters use a **clickable, date-only calendar** with
   explicit "از تاریخ", "تا تاریخ", month/year/day selection, apply/cancel
   and clear-range actions. Manual typing and hour/minute fields are absent.
   The selected first and last dates are both inclusive. Reject inverted and
   invalid dates, including non-leap Esfand/February.
5. `FAIR_REPORT_CALENDAR=jalali|gregorian` controls Owner-report **display and
   calendar-month grouping**. It is independent of `FAIR_TIME_ZONE` and of
   `FAIR_REPORT_WEEK_START_DAY`. Default is `jalali`, preserving existing
   behavior. In Gregorian mode daily labels and monthly periods use actual
   Gregorian dates (January–December), not merely translated Jalali titles;
   weekly boundaries keep the validated configured weekday. Invalid calendar
   ENV values explicitly fail startup. Changing the report calendar never
   reinterprets UTC source instants, rerates any daily charge or rewrites a
   completed run. The run's recorded time zone remains authoritative when
   displaying its historical timestamps, even if the environment default
   later changes.

## Architecture and implementation

- Apply the optional Billing Admin restriction to the `periods` endpoint and
  make a single, bounded SQL projection grouped by `local_day,status` across
  the selected run. Count grouped admin-days separately; aggregate booked
  amounts with PostgreSQL numeric and TypeScript `bigint` strings. Fetch
  booked charge GiB in one query, never once per admin or per period.
- Group aggregate daily rows with the existing pure period reducer; allow
  Jalali or Gregorian civil bounds while preserving the persisted Jalali
  source-day representation and verified archive coverage semantics.
- Keep Owner-authentication, no-store responses, fail-closed catalog/identity
  checks, SHADOW-only labeling, existing read-only SQL and pagination.
- Expose the selected report calendar on the authenticated overview response
  so the Next.js UI uses the same calendar as the API. Date-filter requests
  are validated in the selected calendar and converted to storage Jalali for
  operation/ambiguity views. No database migration is needed.
- New Compose configuration is one strictly allowlisted ENV mapping and must
  pass the protected, Owner-only staging calendar approval workflow before
  a post-merge release can proceed. That approval changes neither database
  rows nor running containers; the normal Deploy workflow remains responsible
  for the reviewed release.

## Acceptance tests

- Two or more Billing Admins on the same date create **one** unfiltered
  daily/weekly/monthly row, with exact sum and ready-only subtotal. Filtering
  one admin returns its own amount; resetting returns the original total.
- One held admin-day and one ready admin-day in the same period are not
  finalized or counted as zero. Global ready amounts match booked ledger sums;
  unbooked candidates remain excluded.
- Gregorian February/November and leap dates, Jalali Esfand/Farvardin and
  week boundaries are validated. Gregorian-date filters reach the same immutable
  source events as their Jalali equivalents.
- Browser regression confirms optional named manager filter, single-row
  totals, no manually typed dates, apply/clear range and stale-response safety.
- TypeScript, relevant unit/PostgreSQL integration/browser tests, lint,
  formatting, full CI, manual security review and the staging approval gate
  are required before the Owner decides on a merge.

**Explicit exclusions:** CSV export, modifying SHADOW amounts or history,
real billing, joining separate runs, PasarGuard writes, live financial
deployment and automatic PR readiness/merge.

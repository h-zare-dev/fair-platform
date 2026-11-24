# FP-006/007 — Owner-only historical SHADOW financial audit and per-admin reports

**Status:** **Owner-approved for implementation 2026-11-24** (all three choices
confirmed in conversation). Implementation belongs in Draft PR #116; the Owner
alone marks Ready, merges and authorizes Staging release.

**Source:** Owner request of 2026-11-24 after the 30-day SHADOW trial. The Owner
requests the identity/account/event detail behind the 45 holds, the approximately
1,438 charge candidates withheld by admin-day finality, and independently
checkable daily, weekly and monthly financial reports for each historical Billing
Admin. This is the first of two proposed audit/production-readiness PRs, **not**
authorization to activate the webhook or to begin LIVE accounting.

## 1. Scope and non-negotiable invariants

1. Read only **completed, immutable `replay-30d` SHADOW runs** and the existing
   normalized source events. The report explicitly identifies the selected
   run, source, cutoffs, time zone, correlation window, delete-credit ENV policy,
   price-catalog hash and Owner-attested fixed-price assumption. It never
   presents archived Billing Admin IDs as verified live `primary` identities.
2. Keep the existing accounting classifier, original immutable runs/entries,
   `fair_shadow_*` tables, PasarGuard, live balances and report-delivery systems
   unchanged. This feature **must not settle holds, generate invoices, credit
   balances, or post financial entries**. Reporting cannot change a classification
   or price.
3. Canonical money is signed integer Toman, sent over JSON as decimal strings;
   bytes are exact integer strings and displayed as fractional GiB without
   rounding the underlying quantities. The 25 historical package prices and
   durations are not silently recreated from 2,000 Toman/GiB.
4. Keep the original fail-closed behavior: a blocked Billing Admin/day has
   **no booked amount**. `null`/pending is never displayed as zero. Aggregation
   that contains a blocked day is marked incomplete and is never called final.
   Approved days remain visible separately and never get repriced. The
   1,438 held candidates are **unposted**, not lost or already charged.
5. Reports expose personal usernames/identifiers **only to the authenticated
   Owner** after explicit security review. No public JSON, browser cache,
   analytics, CI artifact, server log, raw webhook/payload, subscription link,
   credential or unrestricted CSV export may contain private source data.

## 2. Owner UI and API contract

Create a **top-level «گزارش‌ها» page** alongside «داشبورد» and «تنظیمات» in the
main Owner navigation (**approved 2026-11-24**), with a «ممیزی دفتر آزمایشی»
workbench separate from the existing dashboard SHADOW run controls. Include
the following tabs and filters:

| Tab | Filters | Required rows and information |
| --- | --- | --- |
| «مدیران» | Run, historic Billing Admin ID / searchable historic username | Each admin's event-day count, ready/pending days, booked charge, credit and net, held operation/candidate counts, reconciliation state. Do not join an archive ID to a live admin without a verified mapping. |
| «روزانه» | Run, one historic Billing Admin, Jalali date range | One row per observed admin/day; status `SHADOW_READY` or `PENDING_REVIEW`, entries, charges, credits, net or **pending**, hold codes and count. Drill into the booked operation lines with source-event IDs, affected account ID/username, kind (`CREATE`, `RENEWAL`, etc.), package exact bytes+duration, frozen Toman price, source time and reference to the credited purchase. |
| «هفتگی» | Run, one historic Billing Admin, Jalali week/range | Aggregate **only immutable booked daily lines** using the validated ENV-configured local week boundary (default Saturday–Friday). Show covered/ready/pending days, ready-only subtotal and a prominent **incomplete** marker if any day is held or archive coverage is not proved. No fabricated final total. Drill down to constituent days. |
| «ماهانه» | Run, one historic Billing Admin, Jalali month | Same integrity rules, using the calendar package for Jalali Esfand/Farvardin/leap boundaries and business-local time zone. Drill down to weeks/days. |
| «ابهامات» | Run, admin, date, reason, pagination | One row **for each of the original 45 holds** (the exact count is run-dependent): historic Billing Admin ID/username, account ID/username, reason code, event IDs, source timestamps, action chronology, prior/current limit and verified duration if present, held admin/day. Never infer unobserved prior state. |
| «عملیات متوقف‌شده» | Run, admin, date, kind, pagination | One row per **hypothetical unposted candidate** on a held admin/day, including package, source-event chain, candidate amount, blocking hold/day and a conspicuous `NOT_BOOKED` label. Full candidate count reconciles to `held_candidate_count` (1,438 on Owner's displayed run). This is **not** added to SHADOW totals. |
| «رویدادهای بدون اثر مالی» | Run, action, pagination | Count by action and the *reason for being ignored*, reconciling to `ignored_count` (43,167 in the displayed run). If the current pure calculator lacks a per-event reason, add a read-only deterministic diagnostic classification; never infer monetary effect. |

### Identity and source evidence

- Historic Billing Admin name is resolved from `pasarguard_events.billing_admin_username`
  **within that same source archive**. Historic account name comes from
  `pasarguard_events.username`. When a name is absent, inconsistent or has
  changed, show the numeric ID plus `نام نامطمئن/ناموجود` and all source
  observations; do not choose a name arbitrarily. Both the Billing Admin and
  Actor Admin are shown only when independently verified, and must not be
  confused. Preserve account IDs as numeric strings.
- A hold's timeline includes **all directly referenced** source events and
  enough preceding context to explain the decision without disclosing raw
  encrypted payloads. Action labels, source event IDs/times, old/new bytes,
  duration evidence and exact hold code are inspectable. Other-account data
  cannot leak through a search or pagination cursor.
- Run selector defaults to the latest completed run; older immutable runs
  remain available, enabling delete-credit ENV-off/ENV-on comparisons without
  silently combining them.

### Owner-approved configurable business week (2026-11-24)

- The Iranian reporting default is **Saturday 00:00 through the following
  Saturday 00:00 (exclusive)**, i.e. Saturday–Friday as the seven visible days.
  The business-local calendar is calculated in `FAIR_TIME_ZONE`; never use a
  hardcoded 24-hour UTC interval to define its bounds.
- Add the startup ENV setting `FAIR_REPORT_WEEK_START_DAY` with the default
  `SATURDAY`. Valid values are exactly `SATURDAY`, `SUNDAY`, `MONDAY`,
  `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY` (case-insensitive input may be
  normalized once at startup). An invalid value **fails startup explicitly**;
  never silently change to a different reporting week.
- Weekly reports follow the *currently configured* week boundary and include
  `weekStartDay`, local start/end dates, `timeZone` and `runId` in their
  response and UI. ENV changes affect **only grouping of future read-only
  report requests**; never rewrite SHADOW entries/days, historic event dates,
  or posted amounts. Two report exports/views with different week settings
  are not blindly comparable; show that distinction.
- Monthly reports always aggregate the directly selected Jalali month's
  **daily** entries, not whole weeks that overlap a month boundary. A change
  of weekly start cannot alter monthly or daily totals.
- Tests cover Saturday/Friday boundary, a configurable alternative start,
  changing ENV without repricing, week spans across Esfand/Farvardin, DST
  and time zones with non-24-hour local calendar days.

### Pagination, privacy, errors

- Add Owner-only **GET** endpoints under
  `/api/v1/owner/operations/accounting/replay-shadow/audit/*` with bounded
  `runId`, `billingAdminId`, Jalali date / month, `reason`, `kind`, and cursor
  inputs. Validate and constrain all filters; max page size 100. Use bound SQL
  parameters and indexed ordering `(run_id, billing_admin_id, local_day, key)`.
- Return `Cache-Control: no-store` and `Vary: Cookie` for identifiable data.
  No identifiers or details in URL fragments routed to third parties. Hide
  fields unused for the audit; never return raw payload JSON or secrets.
- `401` for missing Owner authentication, stable validation error for malformed
  filters, bounded `404` for missing run and clearly labeled `INCOMPLETE` for
  a pending/failed run. No private identifying data in errors.
- The feature is a Persian RTL Owner table with search, run/date/admin filters,
  pagination, readable Toman numbers, status badges, evidence details, and
  explicit SHADOW/no-real-balance warnings. The user can inspect each admin
  without guessing an ID. A filtered download may be added **only** if the
  Owner independently approves an access-controlled sensitive-data export
  policy; no CSV in the baseline implementation.

## 3. Financial audit, totals and conservation checks

The report must include an Owner-visible read-only reconciliation panel:

1. For the selected run, `SUM(CHARGE)` and `SUM(CREDIT)` from immutable entries
   independently match the sums of `SHADOW_READY` days. `net=charge-credit`
   is exact `BIGINT`, and summed per-package/per-operation/admin/day amounts
   match the overall immutable journal. A mismatch is a **hard error**, not a
   warning that an Owner may ignore.
2. Every booked operation belongs to exactly one ready day and references only
   archive events of the same Billing Admin/account; source-event IDs are
   traceable, and no duplicate operation key or credit reference is counted
   twice. Each credit must have a provable referenced purchase in its run.
3. Every pending day has at least one hold, **no financial entries** and null
   financial totals. Its complete unposted candidate lines are distinctly
   enumerated; per-day candidate counts sum exactly to the run's
   `held_candidate_count`. The separate hold list also sums to `held_count`.
4. The nonfinancial event diagnostic count plus priced source-operation input
   categorization reconciles to `event_count` without naively equating *events*
   and *operations* (one renewal may consume Reset+Update events). Report both
   units explicitly.
5. Run a **second, independently implemented pricing oracle** against
   anonymized golden cases and a bounded private archive comparison. Assert
   exact integer amounts for all 25 package shapes, each operation kind,
   repeated/dual renewals, date boundaries, held days and both ENV policies.
   Do not label the audit `VERIFIED` merely because two group-bys of the same
   original journal agree; that only checks internal consistency.
6. For the existing historical run, recompute unposted candidate evidence
   **only if** a verified current 25-package catalog produces exactly the
   frozen `catalog_hash`. If it differs, fail closed with
   `HISTORICAL_CATALOG_UNAVAILABLE`; never reprice with new settings. For new
   runs, persist an immutable snapshot of package `(id,bytes,days,amount)`
   and the unposted candidate evidence under a forward-only migration so
   future historical reviews require no mutable current catalog.
7. A daily/weekly/monthly audit response includes an integrity status:
   `RECONCILED`, `PENDING_REVIEW`, `ARCHIVE_PARTIAL` or `INTEGRITY_ERROR`.
   Unobserved dates are not automatically asserted to be complete zero-day
   financial periods; display verified archive coverage separately.

## 4. Performance and implementation boundaries

- No full 64k-event calculator run on *each* table request. Prefer immutable
  run-indexed SQL/projections; legacy-run candidate reconstruction is bounded,
  cacheable by run ID and verified catalog hash, without mutating its evidence.
- Keep owner role grants to the minimum necessary `SELECT` on immutable audit
  relations (plus existing journal inserts); make migrations strictly
  additive with schema-forward compatibility and CI migration coverage.
- No real PasarGuard API fetch, no new webhook, no Telegram, no financial
  `INSERT` into live tables, no settlement scheduler, no history rewrite.

## 5. Verification / acceptance gates

| Gate | Expected evidence |
| --- | --- |
| Access | Unauthenticated/expired Owner session cannot read any report, details or names; bounded validation/pagination; no-cache headers. |
| Baseline parity | Existing SHADOW run summary and immutable rows unchanged before/after all report queries; 45 hold rows and candidate total 1,438 reconcile if this exact run is selected. |
| Period arithmetic | Per-admin day sums = per-admin week/month contributions = booked global total for a fully covered period, in integer Toman, including negative net when credits exceed charges. Week start is controlled by `FAIR_REPORT_WEEK_START_DAY` (default Saturday), and months sum days independently of overlapping weeks. |
| Held-day honesty | A held day never becomes zero or finalized merely because its candidate operations were priceable; monthly/weekly reports containing that day remain incomplete. |
| Names / chronology | Same-archive admin/account names/IDs and event chronology only; missing/change/conflict signaled, no unauthorized source-to-primary mapping. |
| Independence | Test oracle built separately from production calculator, 25 shapes × Create/Increase/Reset/Renewal, repeat renewals, delete credit off/on and mismatch cases. |
| Infrastructure | Unit, integration with real PostgreSQL, UI, TypeScript, lint, source-format, CI migration, privacy/no-real-posting regressions. |
| Staging | After Owner merge, compare run 2/3 and manually inspect all holds, 1,438 candidates, per-admin sample days, and global journal totals on disposable Staging. Archive remains local/private. |

## 6. Explicit choices required from Owner before implementation

1. **Weekly boundary — APPROVED 2026-11-24**: default Iranian **Saturday–Friday**,
   configurable using `FAIR_REPORT_WEEK_START_DAY` ENV and `FAIR_TIME_ZONE`
   for local date boundaries. No further choice needed.
2. **Sensitive details — APPROVED 2026-11-24**: show historic Billing Admin and
   account usernames/IDs, action chronology and exact operation amounts in
   Owner-authenticated UI only, without CSV export.
3. **Held-period presentation — APPROVED 2026-11-24**: show a **separately labeled
   sum of ready days** alongside `PENDING_REVIEW`, but **never** a final
   weekly/monthly balance until all constituent days are reconciled.

The Owner explicitly approved these choices and requested comprehensive
per-admin reporting. This authorizes the code/test changes in Draft PR #116,
**not** financial production activation, webhook connection, Ready or Merge.

## 7. Staging release sequence and human acceptance

The new audit migration and `FAIR_REPORT_WEEK_START_DAY` Compose mapping are
deliberately behind the existing protected Staging approval gate. Following
Owner review and merge to `development`:

1. As repository Owner `h-zare-dev`, manually dispatch the protected workflow
   **Staging Shadow audit read-only evidence migration approval (Owner only)**
   on `development`, entering `APPROVE_SHADOW_AUDIT_STAGE`. This only approves
   the exact additive migration/ENV mapping and checks the immutable image;
   it does not apply SQL, post balances or deploy.
2. Re-run the protected `development` deployment. If a source/archive or
   historical catalog error appears, **stop** and do not switch on LIVE
   accounting. The default week begins Saturday; use the accepted Staging ENV
   value to change it only deliberately.
3. Sign into the Owner panel, open the new top-level **«گزارش‌ها»** tab, select
   the last completed 30-day SHADOW run, and check the archive count and
   integrity status. Compare the recorded run totals to the existing SHADOW
   summary independently; verify the 45 holds, 1,438 unposted candidates and
   43,167 nonfinancial events **only when the selected run actually has those
   recorded counts**.
4. Search historic Billing Admin names; review a few ready and pending days,
   week boundaries (Saturday–Friday), Jalali month boundaries, exact frozen
   package prices, negative credits and associated source-event chronology.
   Check every hold reason and held candidate with the same-archive account
   identity. A pending period must never show a final balance.
5. Keep the application in SHADOW: no webhook activation, no credit transfer,
   no CSV export, no real balance alteration. Owner acceptance of these
   reports is **not** approval to begin LIVE posting or scheduled settlement.

Local unit/TypeScript/operator-gate checks are available without a database.
The PostgreSQL migration, immutability, identity and detailed journal
integration tests require a real container runtime and must pass in CI before
the Owner marks the PR Ready or merges it. The full historical 30-day result
must be rechecked on Staging; no private archive is embedded in the PR.

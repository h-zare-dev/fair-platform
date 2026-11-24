# FP-006/007 — Owner-only historical SHADOW financial audit and per-admin reports

**Status:** detailed implementation proposal; **requires explicit Owner approval before code changes**.

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

Add the «ممیزی دفتر آزمایشی» section under Operations/Accounting, separate
from the existing SHADOW summary, with the following tabs and fixed filters:

| Tab | Filters | Required rows and information |
| --- | --- | --- |
| «مدیران» | Run, historic Billing Admin ID / searchable historic username | Each admin's event-day count, ready/pending days, booked charge, credit and net, held operation/candidate counts, reconciliation state. Do not join an archive ID to a live admin without a verified mapping. |
| «روزانه» | Run, one historic Billing Admin, Jalali date range | One row per observed admin/day; status `SHADOW_READY` or `PENDING_REVIEW`, entries, charges, credits, net or **pending**, hold codes and count. Drill into the booked operation lines with source-event IDs, affected account ID/username, kind (`CREATE`, `RENEWAL`, etc.), package exact bytes+duration, frozen Toman price, source time and reference to the credited purchase. |
| «هفتگی» | Run, one historic Billing Admin, Jalali week/range | Aggregate **only immutable booked daily lines**. Show covered/ready/pending days, ready-only subtotal and a prominent **incomplete** marker if any day is held or archive coverage is not proved. No fabricated final total. Drill down to constituent days. |
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
| Period arithmetic | Per-admin day sums = per-admin week/month contributions = booked global total for a fully covered period, in integer Toman, including negative net when credits exceed charges. |
| Held-day honesty | A held day never becomes zero or finalized merely because its candidate operations were priceable; monthly/weekly reports containing that day remain incomplete. |
| Names / chronology | Same-archive admin/account names/IDs and event chronology only; missing/change/conflict signaled, no unauthorized source-to-primary mapping. |
| Independence | Test oracle built separately from production calculator, 25 shapes × Create/Increase/Reset/Renewal, repeat renewals, delete credit off/on and mismatch cases. |
| Infrastructure | Unit, integration with real PostgreSQL, UI, TypeScript, lint, source-format, CI migration, privacy/no-real-posting regressions. |
| Staging | After Owner merge, compare run 2/3 and manually inspect all holds, 1,438 candidates, per-admin sample days, and global journal totals on disposable Staging. Archive remains local/private. |

## 6. Explicit choices required from Owner before implementation

1. **Weekly boundary**: use Iranian business week **Saturday–Friday** in
   `FAIR_TIME_ZONE` (recommended), or another Owner-specified boundary?
2. **Sensitive details**: approve displaying historic Billing Admin and
   account usernames/IDs, action chronology and exact operation amounts in
   Owner-authenticated UI only, without CSV export?
3. **Held-period presentation**: approve showing a **separately labeled sum of
   ready days** alongside `PENDING_REVIEW`, but **never** a final weekly/monthly
   balance until all constituent days are reconciled?

The Owner's response approving these choices (or modifying them) is the
implementation authorization. This spec/document itself and any docs-only
Draft PR **are not** an approval or deploy gate.

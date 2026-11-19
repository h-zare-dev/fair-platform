# Fair Platform — Nightly Accounting, Local Groups and Immutable Daily Reports

> **STATUS: OWNER-APPROVED DESIGN DIRECTION (2026-11-19); NOT AUTHORIZED FOR FEATURE IMPLEMENTATION.**
> The Owner explicitly approved the design and publication on 2026-11-19.
> This is a cross-milestone
> amendment to FP-004/005/006/007 and later reporting, not an authorization for
> migration, billing activation, deployment, PR merge or production integration.
> After Owner approval, update `docs/DOMAIN_RULES.md`, `docs/ARCHITECTURE.md`,
> relevant ADRs and milestone-specific approved implementation specifications
> **before writing feature code**. Existing approved semantics remain authoritative
> until that review is complete.

## 1. Goal and boundaries

Daily accounting is **calculated and posted only by the scheduled night-close**,
never at webhook receipt or during daytime user/group/configuration edits. Receive,
authenticate, normalize, deduplicate and durably store webhooks immediately. Preserve
their verified source timestamps and identities. No daytime quote or posting is
part of the financial pipeline; any Owner-only synthetic preview is explicitly
non-financial and must be labelled as such.

Close one **source instance + Billing Admin + local business date** independently.
An unresolved ambiguity blocks only that admin/date, not following dates or other
admins. When resolved, close and deliver each delayed date individually and in
calendar order. Weekly/monthly summaries wait for all constituent daily closures
of the *same* admin; they sum immutable daily entries without consulting today's
prices or replaying source events. No re-rating or silent rewrite of a finalized
or delivered period.

Postgres 17 owns all critical state and pending delivery obligations. Keep the
existing immutable SHADOW ledger and append-only normalized events. **Do not**
activate LIVE billing or upstream Pasarguard connectivity under this specification.

## 2. Calendar, cutoff and scheduling

- `FAIR_TIME_ZONE=Asia/Tehran` (validated IANA zone; no fixed-offset assumption)
  defines local dates and Jalali business days. Persist instants as UTC
  `timestamptz`; daily intervals are local-date `[00:00, next 00:00)` converted
  to UTC, including timezone-rule changes and DST in other configured zones.
- `DAILY_SETTLEMENT_RUN_AT=02:00` is an Owner-editable environment configuration
  for processing the **previous completed business date**. Setting `00:00`
  does not change the accounting boundary or shorten the preceding date.
- `DAILY_SETTLEMENT_GRACE_MINUTES=10` is a default technical delivery-lateness
  allowance, adjustable by the operators (config/ENV is acceptable). **Actual
  run time = configured local processing time + grace**, but never before the
  preceding business day's midnight boundary. Therefore `00:00` with 10 minutes
  runs at `00:10`, and `02:00` with 10 minutes runs at `02:10`.
- Scheduler uses a durable per-period job, catches up missed days after downtime,
  does not double-post under retries/multiple workers, and rejects impossible
  timezones or clock values. A delayed run must still read the *original day's*
  group/pricing context, never current mutable settings.
- Exactly one finance boundary per local date; week/month follow the Jalali
  business calendar, not Gregorian month or a fixed 30-day span. Package duration
  is **integer days**, independent of Jalali/Gregorian month length.

## 3. Group membership: minimal UI, separate audit history

- Local groups exist **only in Fair Platform**. Pasarguard's inbound groups are
  irrelevant; fetch only a read-only Pasarguard admin directory through authorized
  API access for the searchable admin picker. Never query its database directly.
- An admin is in **zero or one** Fair group at a time, scoped by source instance.
  UI: select admin, choose group, click **Assign / Remove / Transfer**; no
  membership-effective date fields, no extra correction/next-day UI toggle.
- Every membership operation is append-only audited: actor, source, billing admin,
  old/new group, change instant (UTC), operation ID, and optional safe rationale.
  Present a separate, chronological **Group membership history** showing when the
  admin entered and left each group (local Jalali dates/time for audit display).
  Transfers atomically close the old membership and start the new one; concurrent
  membership commands cannot create two active groups.
- **Owner-confirmed daily price selection**: the admin's group at the close of
  the *business day* applies to that admin's entire day's billable operations.
  Example: mistaken A at 09:00 corrected to B at 17:00 => B for that date.
  The actual edit timestamps remain in history for audit; they **do not** split
  one day's group price. If the admin has no group at close, direct admin pricing
  may still apply; otherwise raise missing-pricing exception, never invent a
  default tariff.
- Freeze the **end-of-day group and price context** per admin/date before any
  delayed ambiguity resolution. Changing groups on a later date must not alter
  the previous date's still-pending financial calculation. Separately preserve
  the source-verified Billing Admin owning each event; a transfer of a Pasarguard
  user between Billing Admins is NOT a Fair group correction and retains its
  previously approved ownership semantics. If the worker is down at midnight,
  reconstruct the exact end-of-day state from durable timestamped membership
  history and price-change records before freezing it; **never** use current
  group membership merely because the worker restarted days later.

## 4. Atomic packages, dates and pricing precedence

- A reusable fixed package has stable ID, display name, `package_bytes BIGINT`,
  `duration_days INTEGER` (positive), and `amount_toman BIGINT` (positive).
  UI displays traffic only as GiB (`1 GiB = 1,073,741,824 bytes`) and days,
  never TB or floating-point money. Store original source bytes exactly.
- A package has **no start/end dates**. Before any historical assignment or
  financial use it may be corrected; after assignment its financial fields are
  permanently locked. Provide **Copy package** to create a separately named,
  separately priced package. No user-visible version-management workflow and
  no global uniqueness restriction on `(package_bytes, duration_days)` in the
  catalog (different groups can have different prices for an identical shape).
- Assign package/rate to group or directly to admin. Start date is an optional
  Jalali date-only field (blank = current local date, inclusive); end date is
  optional (blank = unlimited, otherwise inclusive). Persist UTC half-open
  intervals. Start is never editable after creation. End may change only if it
  cannot affect any closed/reported financial period and introduces no overlap;
  verify this transactionally, not only in the form.
  A pending financial day with a **frozen context** is also protected against
  any subsequent edit that would change that day's eventual price.
- Only one active assignment of the **same `(bytes, days)`** may exist for a
  given target (group/admin) over an overlapping period. Different package
  shapes (50 GiB/30 days vs 50 GiB/60 days) may coexist. Reject inclusive-end
  overlaps as a conflict; a new plan can start the day *after* prior end.
  `Replace package` may propose those two dates but must require Owner review
  before committing both atomically.
- A group's normal tariff mode is **either** exact fixed packages **or** per-GiB
  pricing over the relevant period, not both. Direct admin-specific assignments
  override group pricing when present, without creating a system default tariff.
  The highest-priority applicable rule must be deterministic; its missing fixed
  package must raise an exception, not silently fall through to a cheaper tier.
- Both Pasarguard template-based and manually created accounts use the same
  exact match on `(package_bytes, duration_days)` plus the chosen admin/group
  pricing context **when that target is in fixed-package mode**. Example:
  50 GiB/25 days with no matching fixed package becomes a typed exception.
  An explicitly assigned **per-GiB-only group** uses its exact byte-based rate
  and does not invent a fixed-duration package price. No automatic
  approximation or template-only restriction.
  Verify that the Pasarguard webhook or approved read-only API reliably exposes
  **duration in days**; if not, do not guess or price automatically.

## 5. End-of-day correlation, posting and ambiguity resolution

1. **Ingest now, finance later.** The receiving path durably stores webhooks
   and a source-identity-safe idempotency key immediately. It does not call
   pricing or ledger-posting services. Normalization may process during the
   day but no accounting computation runs until close.
2. **At nightly close**, select all source events attributed to the local date
   by verified source timestamps, including lateness-grace arrivals. Derive
   **distinct valid financial operations** from the event sequence; never just
   bill the final account state because independently valid same-day renewals
   must remain separate. Use stable identity, not names or timing alone.
3. Reset+Update retains the established verified source-time correlation
   contract (currently Owner-configurable 120 seconds). Mistaken
   Create/Delete/Recreate or a larger-size correction is a *distinct business
   case*: only automatically supersede the earlier charge if verified stable
   source/user identity and event semantics **prove** a correction. A proposed
   two-hour correction window is not proof on its own. If ambiguous, create
   `AMBIGUOUS_CORRECTION` and await authorized manual resolution. Existing
   no-refund-on-Delete rule otherwise remains in force until explicitly amended.
4. Resolve each billable operation using the day-end admin group, relevant
   date-effective assignment, exact package bytes + integer duration, or
   applicable direct admin override. A missing/duplicate match or missing source
   duration becomes a typed exception. Never silently price as zero.
5. If any **financially blocking exception** exists for that admin/date, mark
   the day `PENDING_REVIEW` and do **not** finalize or deliver its report.
   Other dates for the same admin and other admins may independently close and
   deliver, including zero-charge days. A pending earlier date does not block
   subsequent daily settlements.
6. After the Owner/authorized operator resolves all blocking exceptions, use
   the **frozen original day context**, not latest membership/pricing, to
   calculate/post that day, and issue its *own* report. Resolve queued past days
   deterministically and send them separately in date order. Manual resolution
   must be audited and idempotent, not directly alter already posted ledger.
7. Within a **single DB transaction**, persist the unique admin/date closure,
   per-operation immutable SHADOW ledger transactions and event links,
   exact priced rule/package provenance, immutable daily amount/line snapshot,
   and a durable outbox delivery obligation. Any error rolls back the entire
   admin/date close. `FINANCE_IDEMPOTENCY_CONFLICT` fails closed. Report delivery
   retries reuse the same report identity without sending an altered amount.
8. The final daily amount is the sum of **integer Toman charges** (including
   legitimately empty days with total zero); never reprice during weekly/monthly
   aggregation, never sum rounded GiB as a shortcut. Final financial records
   and sent report content are immutable.

### State and ordering

- Per `(source_instance_id, billing_admin_id, local_business_date)`:
  `COLLECTING` → `ELIGIBLE` → (`PENDING_REVIEW` ↔ `ELIGIBLE`) →
  `FINALIZED` → `SENT`. `SENT` is delivery-state metadata, not a mutation of
  the financial snapshot. Delivery failures remain retryable with outbox state.
- Weekly/monthly report for an admin is `WAITING_DAILY` while *any* date in
  that Jalali week/month is not `FINALIZED`. Other admins' week/month reports
  are unaffected. Once complete, aggregate immutable daily lines, persist an
  immutable report snapshot, enqueue delivery and mark sent on acknowledgment.
- **Late event after `FINALIZED`**: never modify the already sent or finalized
  day. Store `LATE_EVENT_AFTER_CLOSE` for Owner review; a separately authorized
  future adjustment process is required to account for legitimate late debt
  without falsely rewriting history. Do not silently omit the event or
  backdate a ledger transaction into a previously sealed report.
- Admin/day may be delayed for several days. Capture the end-of-day context and
  event-set watermark independently for each date so that later group changes,
  manual resolutions and delayed webhooks cannot silently rebase older days.

## 6. Forward-only PostgreSQL migration proposal

The present `accounting_transactions` is immutable, `entry_type=CHARGE`,
`posting_scope=SHADOW`, requires verified linked events and unique operation
keys. Existing `accounting_exceptions` has `status='OPEN'` only. Current
`fair_pricing_fixed_packages` matches **bytes only**, pricing versions are
effective-dated, and the UI has a system default. The worker currently only
polls ingestion and does not schedule settlement.

**Do not rewrite historical migrations, delete/repurpose ledger rows or silently
reinterpret old pricing plans.** Use additive, forward-only migrations and an
explicitly reviewed staged migration of synthetic configuration:

1. `fair_admin_groups`, `fair_admin_group_memberships` (source+admin uniqueness
   for active membership), and immutable `fair_group_membership_audit`;
   transactional transfer and read-only searchable admin directory cache.
2. New atomic package catalog, admin/group package assignments and per-GiB
   pricing assignments with duration, local-date bounds, exclusion constraints
   for key/scope overlap, historical-reference-aware package edit lock and
   redacted audit. Retain old FP-004 tables until explicit mapping/retirement.
3. `accounting_day_contexts` (business date, zone, `[from_utc,to_utc)`,
   source watermark, frozen group/rate/assignment IDs or immutable serialized
   provenance, configuration snapshot hash) and `accounting_day_closures`
   (unique source+admin+date, status, total, closed time, content hash).
4. `accounting_daily_lines` linked to immutable `accounting_transactions`
   with exact package/duration, billable source event IDs, pricing provenance;
   append-only and unique operation keys. `accounting_daily_reports` immutable
   payload/hash and durable `report_delivery_outbox` (idempotent delivery).
5. Forward migration of exceptions to allow safe `OPEN` / `RESOLVED` states,
   resolution identity/time/reason, context-specific admin/date ownership and
   newly typed `AMBIGUOUS_CORRECTION`, `MISSING_DURATION`,
   `PRICING_CONFIG_CONFLICT`, `LATE_EVENT_AFTER_CLOSE`. Add append-only
   exception-resolution audit; never erase exceptions to hide prior ambiguity.
6. No migrating *live* financial records, no resetting the staging database,
   and no removing rollback/preflight/owner-merge protections. Stage against
   disposable PostgreSQL first and rehearse each forward-only migration. Under
   ADR 0017, the current **disposable synthetic Staging VPS has no host backup
   or restore gate**; do not reintroduce one implicitly. Before **any** separate
   move to persistent data or real billing, obtain a new explicit Owner decision
   on backup/restore and recovery evidence. Never treat an image-only rollback
   as a database restore.

## 7. UI/API behavior

- A short **Groups** screen: group name, searchable admins, one-click assign,
  remove or transfer, current members, a separate **History** view. No
  backdated membership or manual membership period forms.
- A short **Packages** screen: name, GiB, integer days, fixed Toman, edit only
  before first assignment; **Copy package**.
- A short **Assign tariffs** screen: target group/admin, package/rate, optional
  Jalali start/end dates and conflict validation, explicit precedence summary.
- **Accounting ambiguities** grouped by admin/date, with exact source metadata
  needed for a safe decision, typed reason, manual classification/assignment,
  review audit and a retry of **only the held day**.
- **Daily reports** show separate statuses by admin/date, including later dates
  already sent while an earlier day remains `PENDING_REVIEW`; weekly/monthly
  report status makes incomplete-day blockers visible.
- Owner authentication/CSRF/role checks, paginated bounded directory reads,
  no sensitive customer data or credentials in exception messages or logs.

## 8. Required acceptance scenarios

1. Same admin wrongly put in group A at 09:00, corrected to B at 17:00: all
   that day's charges use B; yesterday remains unchanged. History shows both
   membership operations. Next day's transfer cannot reprice a pending earlier
   day (snapshot frozen at the prior cutoff).
2. Template 50 GiB/30 days and manual 50 GiB/30 days both use identical exact
   matching; manual 50 GiB/25 days is held as missing-priced package, not
   treated as 30 days. 50 GiB/30 and 50 GiB/60 coexist.
3. Admin day D has an ambiguous operation: D stays pending; days D+1 and D+2
   settle, are independently delivered and do **not** wait for D. Once D is
   resolved, deliver D as a separate report without duplicating D+1 or D+2.
4. Weekly/monthly report remains waiting while D is pending; once resolved,
   sums fixed daily amounts exactly. Later price/group edits do not change a
   previously sent day/week/month even by one Toman.
5. Verified Reset+Update correlation posts one final renewal; duplicate
   webhook/retry posts no duplicate; genuine separate same-day renewal posts
   independently. Unprovable Create/Delete/Recreate does not silently void
   a charge and is an exception pending Owner review.
6. Scheduler works at `00:10` and `02:10` on the *same preceding local date*;
   with missed days, concurrent workers, crash between DB commit and delivery,
   and retry after report-send acknowledgment loss. No double billing or
   delivery-content mutation.
7. Jalali year boundaries, Shahrivar 31, Esfand 29/30, leap years and at least
   15-year day-by-day library/ICU comparison; IANA DST transition in another
   configured zone, local missing/repeated clock times and UTC half-open ranges.
8. SQL constraints reject overlapping same-shape target assignments and two
   concurrent active groups; assigned package price editing is blocked even
   if later unassigned. Closed-period end-date edits are blocked.
9. Missing source duration, late-after-final webhook, missing pricing, ambiguous
   identity and unknown events all create typed, auditable exceptions without
   silent zero pricing or overwriting immutable reports.
10. Retain OWASP/auth/CSRF and CI controls; regression, unit, PostgreSQL 17
    concurrency/integration, E2E, replay, migration, restart and report tests
    pass in synthetic-only staging. Do not claim success from UI alone.

## 8a. Recommended phased implementation after approval

- **Phase A — FP-004 revised pricing and admin groups:** Owner-approved
  replacement pricing task, local group directory/history, atomic packages,
  exact bytes+days matching, safe forward-only migrations and simplified UI.
  It must not post charges or alter deployed financial operation semantics.
- **Phase B — FP-005/006/007 nightly accounting:** Owner-approved event
  classification/correlation amendments, durable end-of-day context, scheduler,
  per-admin/day all-or-nothing SHADOW ledger posting, exception resolution,
  idempotency, catch-up and independent daily finality.
- **Phase C — reports/delivery:** immutable daily snapshots, durable outbox,
  per-day report hold/release, delayed individual delivery, weekly/monthly
  aggregation and waiting rules. No live financial posting or real Pasarguard
  integration without an independent operational authorization.

These phases preserve existing roadmap milestone names and do not permit
skipping financial source verification or merging unreviewed code.

## 9. Owner decisions embodied, and the remaining explicit approval

**Decisions already stated by Owner:** no daytime financial calculation;
end-of-business-day group for the entire local date; local single-membership
groups and separate history without effective-date UI; timezone and processing
time configured by ENV; default ~10-minute lateness allowance; immutable daily
settlement; each ambiguous **day** held independently; other days delivered;
weekly/monthly totals depend on all completed daily amounts.

**Conservative implementation defaults proposed for Owner approval:**

- Real-time ingestion/normalization stays active, but accounting classification
  and **all financial computation** run only in the nightly close.
- Group config freezes at **local midnight**, not at the later 02:10 processing
  time or the later manual resolution date.
- Create/Delete/Recreate is automatically netted **only when proven** the same
  correction; otherwise needs a reviewed exception, with no automatic refund.
- Late verified events for an already `FINALIZED` date are held for explicit
  Owner-approved adjustment design; they cannot silently rewrite old reports.
- The old default tariff and old pricing rule-version UI are superseded by
  atomic packages + group/admin assignments, but old rows are not dropped or
  silently converted during the transition.

The Owner **approved the overall design and its stated conservative defaults**
on 2026-11-19. Each phased implementation still requires an exact, approved
milestone task specification and testable migration plan before code or financial
migrations begin. Human Owner alone marks PRs Ready
or merges; any rollout remains separately gated and synthetic/SHADOW-only.

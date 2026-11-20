# FP-004 Phase A — Atomic catalog and Fair-local admin groups

**Status: implementation IN PROGRESS in a separate Draft PR, following the Owner's 2026-11-20 explicit request to begin Phase A. NOT READY TO MERGE.** Supersedes no existing financial domain rule. Read the [approved design](FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) and [Owner UI addendum](FP-004-owner-ui-admin-directory-and-timezone.md).

## Phase A scope and safety boundary

- Add a **new** PostgreSQL catalog, separate from legacy `fair_pricing_*`, with atomic reusable package identity, exact integer bytes/GiB, duration **integer days**, price integer Toman, and no package dates. Package financial/identity fields are editable only before any assignment. After the first assignment, a database trigger permanently rejects edits; **Copy package** creates a new identity and price.
- Add Fair-local admin groups with one current group per `(source instance, Billing Admin)`, a simple Owner-only assign/transfer/remove path, and **append-only membership history**. No effective-date membership form. The history will be the future nightly source-of-truth for the group at local business-day end.
- Add group/admin tariff assignments, exact fixed `(bytes, duration_days)` shape or exclusive per-GiB mode. One target cannot have overlapping fixed assignments for the same shape, and cannot overlap per-GiB with fixed on any shape. An admin-specific assignment is the approved priority over its group's tariff; **no new automatic accounting or price resolution is enabled in this PR**.
- Assignment starts/ends are **Jalali date-only**, interpreted in validated IANA `FAIR_TIME_ZONE` (default `Asia/Tehran`). An omitted start means *today in the configured zone*. An omitted end means unlimited. Selected end is inclusive; stored UTC windows are half-open. Existing prices, source timestamps and financial records are unchanged. Start cannot be edited; ending edits are restricted to future boundaries and conflict-checked transactionally.
- New Owner-authenticated, same-origin CSRF-protected `catalog/*` API, and a small groups/packages/assignments UI. **Legacy versioned/synthetic quote API and database remain untouched** for compatibility and safe data migration later. Old editor is collapsed under clearly labeled historical preview until separately audited retirement; it is not the future nightly pricing engine.
- PostgreSQL migration is **forward-only for Staging** (the `down()` implementation is for disposable CI databases). No destructive rewrite of existing synthetic configuration. No production deploy, automatic host backup, change to webhook receiver or financial posting, real Pasarguard API credentials, new security bypass, or change in Owner-only merge.
- Retain exhaustive 2011–2026 daily `jalaali-js` ↔ ICU audit with published Nowruz/leap-year reference and Shahrivar/Esfand boundary cases. Build a tested local-date to UTC-midnight utility across `Asia/Tehran`, Berlin DST and a skipped civil date. Persist timezone with each assignment so later configuration changes do not reinterpret original bounds.

## Not implemented in this initial Draft / hard blockers for claiming Phase A complete

1. The bounded **Pasarguard `admins/simple` searchable directory** and separately approved read-only secret provisioning still need a mock-tested adapter and Owner review. The new UI clearly identifies manual ID input as temporary; the database never reads Pasarguard directly.
2. The new pricing **resolver** (`direct admin > group` at frozen day end, exact bytes+days), synthetic simulation integrated with new catalog, migration of existing synthetic rules, and retirement of legacy default/MIXED/version authoring need separate tests before marking this Phase A PR Ready. No new production or SHADOW charge should consult the new catalog until approved resolution logic is in place.
3. Nightly scheduler, group/day freeze, source operation classification, finance posting, exception review and Telegram/weekly/monthly reporting are FP-005/006/007 and later. They are deliberately not in Phase A.
4. A full PostgreSQL 17 migration/concurrency test (CI/testcontainers) and browser acceptance of the revised UI are mandatory. Local static/type/unit checks alone cannot attest database integrity or browser usability. Deploy/release can only occur after Owner Ready/Merge and post-merge Staging smoke.

## Minimum regression matrix for this PR

- 15 years of Jalali dates, all leap boundaries and unique local day conversion; Berlin 23/25-hour days; bad timezones rejected.
- Package edit before assignment succeeds, package edit after assignment fails even through direct SQL, copying creates new price identity, previous prices remain.
- One group membership per scoped admin; transfer records old/new group in immutable history and change is atomic.
- Fixed 50GiB/30days and 50GiB/60days coexist; two 50GiB/30days overlap fails; fixed vs per-GiB overlap fails; inclusive end/next-start allowed; start mutation rejected, end mutation subject to closed-day and conflict guard.
- `catalog/*` unauthorized or cross-origin writes denied; Staging remains Owner-only and synthetic with no finance ledger transactions generated by catalog writes.

## Deployment observation preceding this work

The Owner-merged PR #80 produced [post-merge CI #337](https://github.com/h-zare-dev/fair-platform/actions/runs/44635467911) on `development` SHA `6b3afe168a1796d3799d581ac92fb30f1a4f2e59`. Quality (676 tests), security, containers, owner-merge, publish and deploy passed; deployment log explicitly emitted `STAGING_SMOKE_OK`, `STAGING_RELEASE_OK <SHA>` and `STAGING_MERGE_DEPLOYMENT_COMPLETE <SHA>`. This is a successful **synthetic Staging** rollout, not evidence of live billing, upstream access or production health.

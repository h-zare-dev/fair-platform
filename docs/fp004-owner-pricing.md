# FP-004 — Owner pricing configuration (staging)

> **HISTORICAL LEGACY EDITOR (2026-11-19).** This page describes the already-deployed, synthetic versioned-pricing preview, **not** the approved future FP-004 atomic catalog or nightly accounting rules. The system-default plan, `MIXED`, per-rule UTC time windows and version-authoring UI documented below are legacy behavior being superseded by [FP-004 Phase A](tasks/FP-004-PHASE-A-IMPLEMENTATION.md) and the [Owner-approved nightly design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md). Do not treat legacy quote results as financial charges. The newer catalog rollout is in a Draft implementation PR and is not yet a verified Staging deploy.

Status: implementation candidate for **Owner review**, not automatically authorized for schema activation or live billing. Business contract: [`tasks/FP-004-pricing-engine.md`](tasks/FP-004-pricing-engine.md).

## Dashboard workflow

1. Sign into the existing Owner dashboard (`https://panel.fairisfair.ir/dashboard`). The Pricing configuration section appears below ingestion events and issues.
2. Enter the **source instance ID**. Plan names are unique per source. Create a plan.
3. Add an immutable rule version for that plan. Supported modes: `PER_GIB` (positive integer Toman/GiB), `FIXED` (exact packages), `MIXED` (exact entries first; per-GiB fallback). In the **Persian dashboard**, enter fixed-package **size (GiB)** and **price (Toman)** in separate fields, for example size `50`, price `150000` (50 GiB for 150,000 Toman); add rows for additional sizes. The UI converts the GiB value to an exact integer byte key for the unchanged API. `FIXED` has no rate; `MIXED` can omit its rate if exact-only behavior is wanted.
4. Select the plan in Assign plan. Leave Billing Admin ID empty to set the source's default, or enter a nonnegative Billing Admin ID to assign a specific admin. Rule versions and assignments must cover the requested source timestamp.
5. For a special override, add a rule version with **Billing Admin override** selected; it has priority over assigned/default plans. The fixed-catalog failure of a selected higher-priority rule does **not** fall through to a lower tier.
6. Use Synthetic quote preview with billable **GiB**, Billing Admin ID, and source event UTC timestamp. The UI converts GiB to exact bytes before sending the unchanged API request. It supports fractional GiB only when the value represents an exact whole number of bytes; it never silently rounds. The result shows integer Toman and the immutable rule version ID; it does **not** create a transaction.

All dates must be UTC, preferably `YYYY-MM-DDTHH:mm:ssZ`. Windows are `[effectiveFrom,effectiveUntil)`. A blank end means infinity. **Existing version and assignment rows cannot be modified or deleted.** For changes, plan the non-overlapping successor window beforehand. The current implementation does not support retroactive correction of an infinite/open-ended rule; use finite windows if revisions will be needed.

The Owner UI is Persian/RTL on login, operational dashboard, pricing forms and history tables. The light/dark toggle persists only a non-sensitive preference in browser local storage; sessions and credentials are unchanged. Displayed event volumes, fixed package sizes and preview quantities are in GiB (1 GiB = 1,073,741,824 bytes), not decimal SI GB. Canonical event/database/API values remain exact integer bytes. Future financial reports still require their independently authorized milestones.

## API boundaries

`GET /api/v1/owner/pricing/config?source=...` requires an authenticated Owner session. `POST /api/v1/owner/pricing/plans`, `/versions`, `/assignments`, `/quote` additionally require the same-origin JSON+CSRF header and Owner session. Requests are validated, bounded and source-scoped. All configuration writes append audit actions, never change the accounting ledger.

## Release/migration protection

This feature adds migration `PricingEngine1791200000000` and updates the runtime-only role grants. The staging auto-release pipeline **compares the candidate migration names and SHA-256 hashes to the human-accepted local VPS baseline** (`compatible-migrations.json`). Until the Owner has separately reviewed and approved the exact candidate migration and an updated local baseline, the existing release gate **must fail closed** for an FP-004 merge. A passing GitHub CI build does not automatically authorize the new database schema. Do not bypass the gate by deleting state, rewriting previous migrations, copying production data, or modifying the expected schema hash directly.

**Historical sentence superseded by ADR 0017:** the disposable synthetic Staging VPS has **no automatic backup or restore**. The isolated `test:backup` CI suite is a synthetic verification, not a real VPS backup. No live billing, Pasarguard integration, automatic accounting charges or customer prices are enabled by the legacy editor.

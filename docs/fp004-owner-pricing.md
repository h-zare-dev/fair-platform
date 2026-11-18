# FP-004 — Owner pricing configuration (staging)

Status: implementation candidate for **Owner review**, not automatically authorized for schema activation or live billing. Business contract: [`tasks/FP-004-pricing-engine.md`](tasks/FP-004-pricing-engine.md).

## Dashboard workflow

1. Sign into the existing Owner dashboard (`https://panel.fairisfair.ir/dashboard`). The Pricing configuration section appears below ingestion events and issues.
2. Enter the **source instance ID**. Plan names are unique per source. Create a plan.
3. Add an immutable rule version for that plan. Supported modes: `PER_GIB` (positive integer Toman/GiB), `FIXED` (exact `bytes:toman` entries), `MIXED` (exact entries first; per-GiB fallback). `FIXED` has no rate; `MIXED` can omit its rate if exact-only behavior is wanted.
4. Select the plan in Assign plan. Leave Billing Admin ID empty to set the source's default, or enter a nonnegative Billing Admin ID to assign a specific admin. Rule versions and assignments must cover the requested source timestamp.
5. For a special override, add a rule version with **Billing Admin override** selected; it has priority over assigned/default plans. The fixed-catalog failure of a selected higher-priority rule does **not** fall through to a lower tier.
6. Use Synthetic quote preview with the exact billable **bytes**, Billing Admin ID, and source event UTC timestamp. The result shows integer Toman and the immutable rule version ID; it does **not** create a transaction.

All dates must be UTC, preferably `YYYY-MM-DDTHH:mm:ssZ`. Windows are `[effectiveFrom,effectiveUntil)`. A blank end means infinity. **Existing version and assignment rows cannot be modified or deleted.** For changes, plan the non-overlapping successor window beforehand. The current implementation does not support retroactive correction of an infinite/open-ended rule; use finite windows if revisions will be needed.

## API boundaries

`GET /api/v1/owner/pricing/config?source=...` requires an authenticated Owner session. `POST /api/v1/owner/pricing/plans`, `/versions`, `/assignments`, `/quote` additionally require the same-origin JSON+CSRF header and Owner session. Requests are validated, bounded and source-scoped. All configuration writes append audit actions, never change the accounting ledger.

## Release/migration protection

This feature adds migration `PricingEngine1791200000000` and updates the runtime-only role grants. The staging auto-release pipeline **compares the candidate migration names and SHA-256 hashes to the human-accepted local VPS baseline** (`compatible-migrations.json`). Until the Owner has separately reviewed and approved the exact candidate migration and an updated local baseline, the existing release gate **must fail closed** for an FP-004 merge. A passing GitHub CI build does not automatically authorize the new database schema. Do not bypass the gate by deleting state, rewriting previous migrations, copying production data, or modifying the expected schema hash directly.

The established encrypted PostgreSQL backup and isolated restore validation remain on the **same VPS**. Nothing is sent to an external server. This task does not enable live billing, Pasarguard integration, automatic accounting charges or user-facing prices.

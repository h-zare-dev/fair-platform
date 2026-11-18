# FP-004 — Pricing Engine (Owner-approved implementation specification)

> **STATUS: APPROVED FOR IMPLEMENTATION BY OWNER (2026-11-18, conversation decision).** The Owner selected **CEIL for final fractional Toman** and **Owner dashboard pricing management in FP-004**, and explicitly approved this spec with those choices. This permits development on a dedicated feature branch, **not** PR merge, production deployment, live billing, or unreviewed database migration activation.

## Source contracts and goal

- `docs/DOMAIN_RULES.md` governs business semantics; `docs/ARCHITECTURE.md`, `docs/SECURITY_POLICY.md`, `docs/TESTING_POLICY.md`, `docs/CODING_STANDARDS.md`, and ADRs 0006/0007 govern implementation.
- Deliver a deterministic, independently testable pricing engine used by **future** FP-005/006/007 accounting features. It prices an already verified **positive billable traffic quantity**, not a webhook action. The engine must neither decide whether an event is billable nor write an accounting charge.
- Preserve canonical bytes as integer `BIGINT`-safe values and quote **integer Toman**. Exactly `1 GiB = 1_073_741_824 bytes`. No `Number` or IEEE-754 arithmetic in financial calculations.
- A quote must include the resolved precedence level, immutable rule/version identifier, mode, billable bytes, effective source timestamp, exact arithmetic inputs and final integer Toman amount. Later ledger integration must be able to persist that version without re-pricing historical charges.

## Owner decisions recorded

1. **Fractional final Toman rounding: `CEIL`.** Compute exactly `rateTomanPerGiB * billableBytes / 1_073_741_824` with `bigint`; if the nonnegative remainder is nonzero, add one Toman. Examples: 0.5 GiB at a 5-Toman/GiB rate => 3 Toman; 0.01 GiB at a 1-Toman/GiB rate => 1 Toman. Fixed catalog prices are already integer Toman and never rounded.
2. **Configuration surface: backend + API + dashboard Owner pricing editor in FP-004.** The existing staging Owner session, CSRF, audit, limits and synthetic-only controls must protect writes. UI supports creating effective-dated plan versions, selecting the default, assigning admins, setting admin-specific overrides, viewing effective rules and previewing a synthetic price. No unauthenticated write endpoints.
3. **Approval identity.** Owner explicitly chose `CEIL`, dashboard UI, and `تأیید می‌کنم` in the interactive approval shown in this conversation on 2026-11-18.

## Domain contract

### Inputs

- `sourceInstanceId` (canonical, validated identity), `billingAdminId` (nonnegative, integer-safe), `occurredAt` (validated UTC source/effective timestamp, not HTTP receipt time), and `billableBytes` (positive integer-safe byte count).
- The FP-005/006/007 classifier supplies the purpose (`FULL_PACKAGE` or `POSITIVE_DELTA`) **after** confirming the billable operation; FP-004 does not infer a purpose, package change, user baseline, reset, Next Plan activation or ownership transfer.
- Unsupported unlimited must fail with the typed `UNEXPECTED_UNLIMITED` outcome. Absent or invalid required inputs fail validation; they never yield zero money.

### Modes and selection

1. `PER_GIB`: multiply the exact integer rate (Toman/GiB) by bytes, divide exactly by `1_073_741_824`, then apply the Owner-approved one-time **final Toman** rounding policy. Do not round the GiB quantity or intermediate money.
2. `FIXED`: look up an **exact positive byte** package/delta in the effective rule's fixed-price catalog and return the listed positive integer Toman. Missing exact package => typed `PRICING_MISSING`.
3. `MIXED`: exact fixed catalog entry wins. Only if that specific package key is absent, fall back to that same rule version's Per-GiB rate; if the rate is also absent => `PRICING_MISSING`. Never fall through to a lower-precedence plan merely because the chosen higher-precedence rule cannot price a particular quantity.
4. Resolve exactly one effective rule in this order: (a) Billing Admin's explicit override; (b) Billing Admin's assigned plan; (c) system default plan. Actor Admin never selects the rule. A missing/ambiguous applicable rule produces a typed failure, not a guessed zero or arbitrary winner.
5. Resolve all history **as of source `occurredAt`** using `[effectiveFrom, effectiveUntil)` UTC intervals, with `effectiveUntil` nullable for infinity. A boundary exactly at `effectiveUntil` uses the successor. Future edits cannot retroactively modify immutable version rows.

### Safety and outputs

- Quote success has a positive `amountToman` within signed 64-bit PostgreSQL `BIGINT` range, serialized as a decimal string; overflow is a typed validation failure, not a wrap or a clamped value.
- Return immutable selected rule/version ID, source instance, admin ID, UTC effective timestamp, mode, resolved provenance (`ADMIN_OVERRIDE`/`ASSIGNED_PLAN`/`DEFAULT_PLAN`), and exact priced bytes. A quote is not a posted charge.
- Return typed failures (`PRICING_MISSING`, `UNEXPECTED_UNLIMITED`, `INVALID_PRICING_INPUT`, `PRICING_CONFIG_CONFLICT`, `PRICING_OVERFLOW`) without persisting a charge. FP-005+ translates pricing-missing results to the existing immutable accounting-exception flow with caller-owned idempotency keys.
- No negative charge or credit/refund in FP-004. A zero-delta or update-only decrease must be handled by the later classifier without invoking a price quote.
- Optional `sourceInstanceId` isolation of admin assignments and overrides is mandatory: the same numeric Billing Admin ID in distinct source instances cannot see another source's price.

## Proposed persistence model (PostgreSQL 17 / TypeORM infrastructure only)

- `pricing_plans`: stable plan identity, validated Owner-visible name, source-instance scope as appropriate, no destructive mutation of referenced history.
- `pricing_rule_versions`: append-only ID, referenced plan or explicit admin override, mode, nullable positive Per-GiB rate as permitted by mode, effective UTC half-open range, creation/audit metadata. Reject overlaps for the **same logical rule owner**; only one effective version can match a timestamp. Each version is immutable once created.
- `pricing_fixed_packages`: immutable per-version catalog, `(rule_version_id, package_bytes)` unique, positive `package_bytes` and `amount_toman` constrained to `BIGINT`.
- `pricing_admin_assignments`: versioned Billing Admin → plan mapping with UTC effective ranges and per-source uniqueness/non-overlap. `pricing_default_assignments`: similarly effective-dated default plan configuration.
- Owner edits create new versions/assignments. Previous entries remain referenceable by ID; validate overlapping windows and reject missing historical paths. Concurrency-safe writes use explicit transactions and PostgreSQL exclusion/unique constraints rather than process-local locking alone.
- Add new forward-only migrations; do not alter or rewrite historical FP-001/FP-002 migration files. Existing FP-002 ledger is unchanged in FP-004; the FP-005 design must add verified pricing provenance to new accounting transactions before any priced SHADOW posting.

## Application and API boundaries

- Pure TypeScript domain in `packages/pricing/src/domain` with independent quote engine, deterministic selector, exact integer arithmetic and typed contracts.
- Application service/ports in `packages/pricing/src/application` accepts read-only effective rule projections; Infrastructure adapters in `packages/pricing/src/infrastructure` implement PostgreSQL storage and explicit migrations. Domain never imports TypeORM, NestJS, HTTP, Redis, Telegram or other runtime frameworks.
- Owner-only API must validate input (including UTC timestamps and decimal-string `BIGINT`), require the existing Owner session and CSRF protection for mutations, audit redacted before/after administrative changes and reject unauthorized/read-only sessions. Do not introduce a public registration flow or financial live-posting route.
- API mutations are explicitly limited to pricing configuration. Quotes against the synthetic staging database may be exposed through a bounded authenticated testing endpoint; no production webhook routes are enabled.
- Staging remains synthetic/shadow only; no Pasarguard credentials, private replay data, accounting transactions, live billing, notification generation or new public data exposure are authorized.

## Acceptance tests and release gates

1. Pure-domain golden tests for Per-GiB, Fixed and Mixed mode; exact bytes (1, 1/2 GiB, 1 GiB, multiple GiB); rounding midpoint/non-midpoint; `BigInt` overflow/precision near signed 64-bit boundaries.
2. Precedence tests: admin override wins over assigned/default; assigned wins over default; missing exact fixed remains missing; Mixed fallback occurs only inside chosen version. Reject inconsistent mode configuration and source-instance cross-read.
3. Effective-date tests: before/at/after boundaries, equal-start conflicts, overlap attempts, immutable historical versions and quote reproducibility after later price changes. Use source event timestamp, never receipt clock.
4. PostgreSQL 17 integration tests through Testcontainers: empty database migration; previous FP-003B database migration compatibility; constraints/FKs/half-open intervals, simultaneous competing Owner writes, rollback on failure, and normalized decimal-string inputs/outputs.
5. Owner API access tests: unauthenticated and CSRF-invalid requests denied, bounded validated inputs, no secrets in logs and no payment/ledger mutations.
6. Exact-feature tests pass; full format/lint/typecheck/unit/integration/e2e/build and CI quality/security/containers green. Review business rules and negative/overflow tests before marking implementation acceptable.
7. Dedicated FP-004 feature branch from current `development`, Draft PR only. **Owner personally** marks Ready and merges. The existing `staging` post-merge automation may run only after a **separately approved compatible migration/baseline update**; otherwise its fail-closed migration gate must stop deployment. Never bypass it or enable live billing.

## Explicit exclusions

- Classifying or charging Create/Update/Reset/Next Plan/Transfer events (FP-005/006/007); applying user baselines; live webhook forwarding; posting or changing immutable ledger data; credits/refunds; Telegram/reporting; multi-currency; unlimited plans; Pasarguard/Pasarjew DB access; production cutover.
- No automatic PR Ready/Merge, no Multi-Agent runner, no live financial side effects.

## Approval record

- Final rounding: **CEIL — approved**.
- Configuration surface: **Owner Backend/API + dashboard UI — approved**.
- Explicit approval of this implementation-grade FP-004 spec: **approved in conversation on 2026-11-18**.

# Fair Platform — Project Blueprint

## Vision
Fair Platform is a production-focused modular platform for Pasarguard accounting, pricing, reporting, automation, and future sales services. v1.0 replaces the legacy Pasarjew accounting/reporting bot while keeping module boundaries extraction-ready for future services.

## Goals
- Correct, auditable money-first accounting.
- Durable webhook ingestion with PostgreSQL as source of truth.
- Explicit pricing/accounting rules with no silent guesses.
- UTC persistence with future Jalali reporting in configurable `FAIR_TIME_ZONE` (initially `Asia/Tehran`).
- Owner-controlled pricing, schedules, exceptions, integrations, and retention.
- Reliable Telegram/CSV reporting with resend/regenerate support.
- Bounded, auditable operational data; **synthetic Staging currently has no automatic backup by Owner exception (ADR 0017)**. Production financial recovery requirements require independent approval.
- Strong automated testing of critical financial behavior.

## Non-Goals for v1.0
- Multi-Pasarguard management UI.
- Full event sourcing.
- Unlimited-plan billing.
- Refunds for update-only decreases.
- Customer/sales platform features.
- Admin self-service dashboard/preferences.
- Pasarguard API reconciliation. Reconciliation is deferred to v1.1+.

## v1.0 Scope
- One Pasarguard source.
- Webhook batch ingestion and durable PostgreSQL inbox/outbox processing.
- Normalized events and immutable accounting transactions.
- Create, increase, decrease, reset, reset+update, automatic reset, Next Plan, delete, auto-delete, and admin-transfer semantics.
- Revised target pricing: stable atomic `(GiB bytes, duration days)` packages, local groups with at most one group per admin, direct admin exceptions above group pricing, date-only effective **assignments** and no system-default tariff. Old FP-004 pricing modes remain in the synthetic code until replacement.
- Owner panel for pricing, settings, reports, exceptions, and audit views.
- Daily, weekly, monthly Telegram reports and CSV generation.
- Immutable finalized daily reports; resend the same stored report, never silently regenerate/reprice historical amounts. Any later adjustment requires a separately authorized, auditable transaction.
- Shadow-mode comparison with Pasarjew before cutover.

## Current phased roadmap

The **authoritative feature sequence, status and release gates** are maintained in [`ROADMAP.md`](ROADMAP.md), with verified/observed deployment state in [the Nov 19 current-status record](CURRENT_STATE_AND_POLICY_2026-11-19.md). FP-003B public HTTPS Owner-only Staging was Owner-approved and has been deployed according to Owner evidence; FP-003C phase-one delivery is merged. FP-004 already contains a **synthetic-only** pricing engine/Owner editor. Its revised local-group and nightly design is Owner-approved but still requires phased implementation; FP-005 first user-create SHADOW accounting, FP-006 baselines/updates, FP-007 resets/renewals and actual daily/Telegram reporting follow their separately approved specifications.

FP-003B is **not** the full v1.0 Owner accounting UI. Its persistent synthetic database is separate from FP-003A disposable replay. `packages/pricing` now implements synthetic quoting, but FP-002 does not classify webhook operations or post live charges. `packages/calendar`, shared/contracts and actual Telegram reporting remain incomplete. See the [FP-003B implementation](tasks/FP-003B-operational-dashboard.md), [nightly design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) and [Staging runbook](deployment/FP-003B-staging-runbook.md).

### v1.1+
- Pasarguard state reconciliation and integrity tooling.
- Pasarguard-admin login and admin-facing dashboard/report history/preferences.

### v1.2+
- Operational analytics, anomaly detection, deeper monitoring, report UX improvements.

### v2
- Separate Sales/Customer bounded context.

## Roles
### Owner
Controls pricing, schedules, retention, integrations, exceptions, and global settings. In v1.0, report schedules and correlation settings are Owner-only.

### Pasarguard Admin
Receives reports according to billing ownership. No self-service settings in v1.0.

## Technology
Node.js 24 LTS, TypeScript, NestJS 12, Next.js 16, TypeORM, PostgreSQL 17, Redis only for ephemeral concerns, pnpm, Zod, Vitest, Testcontainers, Supertest, Stryker, Docker/Compose, GitHub Actions, Prometheus/Grafana.

## Deployment
**FP-003B STAGING** is an independently isolated public Docker deployment on a *separate* VPS at `https://panel.fairisfair.ir`: Caddy HTTPS/TLS-ALPN-01 via Cloudflare DNS-only, Owner-authenticated Next.js/NestJS API, PostgreSQL 17 with synthetic-only persistent data, and reviewed GitHub Actions→GHCR→SSH post-merge auto-delivery. The Owner reports successful Persian dashboard activation. Public web ingress is TCP/443; host SSH uses the **accepted staging-only root-password bootstrap exception** (ADR 0016), **not** a verified key-only policy. No automatic staging backups/restores are configured (ADR 0017). Internal app containers publish no ports; no Pasarguard production integration or live billing is authorized.

**Later v1.0 production** remains separately planned for an isolated stack on/near the Pasarguard VPS, with separate PostgreSQL and HAProxy routing review. Fair never reads or writes Pasarguard database tables directly. It is not activated by FP-003B.

## Shadow Mode
Fair and Pasarjew run side-by-side for at least 7–14 days and longer if needed. Compare events, accounting totals, traffic, money, admin totals, reports, and exceptions. Historical Pasarjew financial data is not migrated into the Fair ledger.

## Success Criteria
- No silent financial ambiguity.
- Idempotent reprocessing.
- Bounded raw webhook storage.
- Reports reproducible from accounting transactions.
- Explicitly tested financial recovery policy before any future production cutover; **disposable synthetic Staging intentionally has no automatic backup/restore**.
- Critical accounting behavior protected by automated tests.

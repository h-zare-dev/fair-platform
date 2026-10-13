# Fair Platform — Project Blueprint

## Vision
Fair Platform is a production-focused modular platform for Pasarguard accounting, pricing, reporting, automation, and future sales services. v1.0 replaces the legacy Pasarjew accounting/reporting bot while keeping module boundaries extraction-ready for future services.

## Goals
- Correct, auditable money-first accounting.
- Durable webhook ingestion with PostgreSQL as source of truth.
- Explicit pricing/accounting rules with no silent guesses.
- UTC persistence with Jalali reporting in `Asia/Tehran`.
- Owner-controlled pricing, schedules, exceptions, integrations, and retention.
- Reliable Telegram/CSV reporting with resend/regenerate support.
- Small, backup-friendly operational data.
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
- Per-GB, fixed, and mixed pricing with effective-dated history and overrides.
- Owner panel for pricing, settings, reports, exceptions, and audit views.
- Daily, weekly, monthly Telegram reports and CSV generation.
- Report resend, regenerate, and revisions.
- Shadow-mode comparison with Pasarjew before cutover.

## Current phased roadmap

The **authoritative feature sequence, status and release gates** are maintained in [`ROADMAP.md`](ROADMAP.md). As of 2026-10-13: FP-001/FP-001B ingestion, FP-002 immutable SHADOW accounting foundations and FP-003A offline historical replay are merged into `development`. **NEXT: FP-003B temporary Owner-only operational dashboard (design pending)**. Subsequent stages: FP-004 pricing, FP-005 first user-create SHADOW accounting, FP-006 existing-user baselines/update accounting, FP-007 automatic/manual reset and renewal/Next Plan correlation. Each needs its own Owner-approved detailed task specification.

FP-003B is **not** the full v1.0 Owner accounting UI. It cannot reuse FP-003A's disposable database as a persistent source. `packages/pricing` is still a placeholder; FP-002 does not classify events or post live charges. See [FP-003B design brief](tasks/FP-003B-operational-dashboard.md).

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
v1.0 runs on the same VPS as Pasarguard in an isolated Docker stack with a separate PostgreSQL database. Fair never reads or writes Pasarguard database tables directly. HAProxy routing is reviewed before production deployment.

## Shadow Mode
Fair and Pasarjew run side-by-side for at least 7–14 days and longer if needed. Compare events, accounting totals, traffic, money, admin totals, reports, and exceptions. Historical Pasarjew financial data is not migrated into the Fair ledger.

## Success Criteria
- No silent financial ambiguity.
- Idempotent reprocessing.
- Bounded raw webhook storage.
- Reports reproducible from accounting transactions.
- Simple backup/restore.
- Critical accounting behavior protected by automated tests.

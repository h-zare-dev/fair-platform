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

The **authoritative feature sequence, status and release gates** are maintained in [`ROADMAP.md`](ROADMAP.md). As of 2026-10-13: FP-001/FP-001B ingestion, FP-002 immutable SHADOW accounting foundations and FP-003A offline historical replay are merged into `development`. **NEXT: FP-003B public HTTPS Owner-only operational dashboard with full staging CI/CD (spec pending Owner approval)**. Subsequent stages: FP-004 pricing, FP-005 first user-create SHADOW accounting, FP-006 existing-user baselines/update accounting, FP-007 automatic/manual reset and renewal/Next Plan correlation. Each needs its own Owner-approved detailed task specification.

FP-003B is **not** the full v1.0 Owner accounting UI. It cannot reuse FP-003A's disposable database as a persistent source. `packages/pricing` is still a placeholder; FP-002 does not classify events or post live charges. See the [FP-003B detailed proposal](tasks/FP-003B-operational-dashboard.md) and [staging runbook](deployment/FP-003B-staging-runbook.md).

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
**Next, FP-003B STAGING** is an independently isolated public Docker deployment on a *separate* VPS at `https://panel.fairisfair.ir`: Caddy HTTPS/TLS-ALPN-01 via Cloudflare DNS-only, Owner-authenticated Next.js/NestJS API, PostgreSQL 17 with synthetic-only persistent data, and GitHub Actions→GHCR→SSH post-merge auto-delivery. Public ingress TCP/443 and key-only SSH TCP/22; internal services publish no ports. A one-time Owner bootstrap CLI creates the sole account; no public registration. No Pasarguard production integration or live billing. This plan requires Owner-approved implementation and first-deploy enablement.

**Later v1.0 production** remains separately planned for an isolated stack on/near the Pasarguard VPS, with separate PostgreSQL and HAProxy routing review. Fair never reads or writes Pasarguard database tables directly. It is not activated by FP-003B.

## Shadow Mode
Fair and Pasarjew run side-by-side for at least 7–14 days and longer if needed. Compare events, accounting totals, traffic, money, admin totals, reports, and exceptions. Historical Pasarjew financial data is not migrated into the Fair ledger.

## Success Criteria
- No silent financial ambiguity.
- Idempotent reprocessing.
- Bounded raw webhook storage.
- Reports reproducible from accounting transactions.
- Simple backup/restore.
- Critical accounting behavior protected by automated tests.

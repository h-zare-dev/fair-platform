# Fair Platform

Fair Platform is a production-focused modular platform for Pasarguard accounting, pricing, reporting, automation, and future sales services.

> **Staging status (2026-11-25).** The Owner completed the 122-day historical SHADOW replay with original PasarGuard identifiers and reviewed the statement totals. Staging already has an authenticated second-webhook endpoint, opening baseline import and a nightly Create-only closer. Historical Update/Reset support and period reports are available in replay. Follow the [webhook pilot](docs/deployment/WEBHOOK-PILOT.md) for the smoke test and the remaining settlement work.

## Technology
- Node.js 24 LTS
- TypeScript
- NestJS 12
- Fastify HTTP adapter
- Next.js 16
- PostgreSQL 17
- TypeORM
- Zod
- Vitest
- pnpm workspaces
- Docker / Docker Compose
- GitHub Actions

## Repository Layout
- `apps/api` — NestJS + Fastify HTTP process.
- `apps/worker` — NestJS application-context worker process without HTTP.
- `apps/web` — Next.js Owner UI.
- `packages/accounting` — accounting domain boundary.
- `packages/pricing` — pricing domain boundary.
- `packages/calendar` — planned shared Jalali reporting/calendar boundary (not yet a complete reporting service).
- `packages/pasarguard` — Pasarguard integration boundary.
- `packages/contracts` — reserved shared contract boundary (partial/placeholder).
- `packages/shared` — reserved cross-cutting primitives boundary (partial/placeholder).
- `tests` — contract, E2E, fixture, and golden-test assets.
- `docs` — authoritative architecture, domain, security, testing, and workflow documentation.

## Prerequisites
- Node.js 24
- pnpm 12.6.0
- Docker with Compose support

Using mise:

```bash
mise install
```

## Local Development
Copy the example environment file, start development infrastructure, then install dependencies:

```bash
cp .env.example .env
docker compose -f docker/compose.dev.yml up -d
pnpm install
pnpm build
pnpm --filter @fair-platform/pasarguard migration:run
pnpm dev
```

Provide a valid `APP_ENCRYPTION_KEY` and load environment variables before running migrations or processes. Webhooks are denied by default; the explicit development/test bypass and full operation details are documented in [FP-001 implementation](docs/tasks/FP-001-implementation.md).

## Quality Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test
pnpm build
```

## Documentation
Start with `AGENTS.md`, then read:
- [`docs/deployment/PRODUCTION-SHADOW-INSTALL.md`](docs/deployment/PRODUCTION-SHADOW-INSTALL.md) — Owner-only isolated production-host installation candidate (Shadow OFF; not financial go-live).
- **[`docs/ROADMAP.md`](docs/ROADMAP.md) — canonical roadmap, current statuses and Owner-only merge gates.**
- [`docs/CURRENT_STATE_AND_POLICY_2026-11-19.md`](docs/CURRENT_STATE_AND_POLICY_2026-11-19.md) — **current** implemented/Owner-observed status and Staging risk exceptions; read before historical planning docs.
- [`docs/tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md`](docs/tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) — Owner-approved **future design**, not yet implemented or authorized for live billing.
- [`docs/tasks/FP-003B-operational-dashboard.md`](docs/tasks/FP-003B-operational-dashboard.md) — historical approved implementation contract.
- [`docs/deployment/FP-003B-staging-runbook.md`](docs/deployment/FP-003B-staging-runbook.md) — current release notes plus explicitly marked historical operator procedures.
- [`docs/adr/0015-public-https-staging-and-controlled-delivery.md`](docs/adr/0015-public-https-staging-and-controlled-delivery.md), [0016](docs/adr/0016-disposable-staging-local-backup-and-owner-merge-cd.md), [0017](docs/adr/0017-no-automatic-backup-for-disposable-synthetic-staging.md) — Staging decision sequence; later scope-limited exceptions override earlier plans.
- `docs/PROJECT_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_RULES.md`
- `docs/integrations/PASARGUARD.md`
- `docs/TESTING_POLICY.md`
- `docs/SECURITY_POLICY.md`

## License
No license has been selected yet. All rights are reserved unless and until a license is explicitly added.

For the seven-day parallel webhook accounting pilot, open **Settings → Initialization**
to copy the second webhook URL and credential. Inspect receipts on the dashboard
and nightly totals and pending decisions under accounting ambiguities.
See [the Staging pilot procedure](docs/deployment/WEBHOOK-PILOT.md).

# Fair Platform

Fair Platform is a production-focused modular platform for Pasarguard accounting, pricing, reporting, automation, and future sales services.

> Status: development. FP-001/FP-001B ingestion, FP-002 SHADOW accounting foundations and FP-003A offline historical replay are merged into `development`. **NEXT: FP-003B public HTTPS staging Owner dashboard and automatic CI/CD — detailed spec pending Owner approval, not yet implemented.** Pricing and financial classification are not yet implemented; live webhook authentication/activation remains separately gated.

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
- `packages/calendar` — Jalali reporting/calendar boundary.
- `packages/pasarguard` — Pasarguard integration boundary.
- `packages/contracts` — validated shared contracts.
- `packages/shared` — genuinely cross-cutting primitives only.
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
- **[`docs/ROADMAP.md`](docs/ROADMAP.md) — canonical roadmap, current statuses and Owner-only merge gates.**
- [`docs/tasks/FP-003B-operational-dashboard.md`](docs/tasks/FP-003B-operational-dashboard.md) — proposed **implementation-grade** FP-003B public HTTPS dashboard/CI-CD contract; Owner approval required before work.
- [`docs/deployment/FP-003B-staging-runbook.md`](docs/deployment/FP-003B-staging-runbook.md) — Docker/Caddy/DNS/SSH/UFW/GHCR delivery and operator recovery plan (**not deployed**).
- [`docs/adr/0015-public-https-staging-and-controlled-delivery.md`](docs/adr/0015-public-https-staging-and-controlled-delivery.md) — public staging architecture decision proposed for Owner review.
- `docs/PROJECT_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_RULES.md`
- `docs/integrations/PASARGUARD.md`
- `docs/TESTING_POLICY.md`
- `docs/SECURITY_POLICY.md`

## License
No license has been selected yet. All rights are reserved unless and until a license is explicitly added.

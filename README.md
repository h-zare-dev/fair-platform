# Fair Platform

Fair Platform is a production-focused modular platform for Pasarguard accounting, pricing, reporting, automation, and future sales services.

> Status: early development. FP-001 implements durable Pasarguard ingestion and normalization. Production webhook activation remains blocked pending verified authentication and deployed-source evidence.

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
- `docs/PROJECT_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_RULES.md`
- `docs/integrations/PASARGUARD.md`
- `docs/TESTING_POLICY.md`
- `docs/SECURITY_POLICY.md`

## License
No license has been selected yet. All rights are reserved unless and until a license is explicitly added.

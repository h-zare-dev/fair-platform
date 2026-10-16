# Architecture

## Style
Fair Platform starts as a **modular monolith with separate runtime processes**. Microservices are introduced only when a stable boundary and operational need justify extraction.

## Runtime Processes
- `api`: HTTP/webhook/admin API.
- `worker`: asynchronous event processing, reports, delivery, cleanup.
- `web`: Owner UI.

## Module Direction
`Controller → Application → Domain ← Infrastructure`

Domain packages remain pure TypeScript and must not depend on NestJS, TypeORM, PostgreSQL, Redis, Telegram, or HTTP.

Feature order and authorization are documented in [`ROADMAP.md`](ROADMAP.md). FP-001/001B ingestion, FP-002 SHADOW ledger and FP-003A offline replay are distinct; FP-003B is a **Owner-approved for implementation (2026-10-14), not deployed** public HTTPS, authenticated Owner-only STAGING dashboard with automatic release delivery, **not** a financial classifier. See [FP-003B spec](tasks/FP-003B-operational-dashboard.md) and [ADR 0015](adr/0015-public-https-staging-and-controlled-delivery.md).

## Source of Truth
PostgreSQL is authoritative for all critical state: normalized events, accounting transactions, pricing, report state, delivery obligations, settings, and exceptions.

Redis is disposable and may be used only for cache, rate limiting, short-lived coordination, and similar ephemeral concerns. Redis loss must not lose accounting, reports, pricing, or pending delivery obligations.

## Persistence
- PostgreSQL 17.
- TypeORM in infrastructure only.
- `synchronize: false`.
- Migrations mandatory.
- No Active Record, lazy loading, or uncontrolled cascades.
- Explicit transactions.
- Repository/QueryBuilder first; raw SQL only for justified PostgreSQL-specific features/migrations.

## Durable Inbox
Webhook receiver authenticates and minimally validates the HTTP envelope, persists the batch in PostgreSQL, commits, and returns success quickly. Business processing occurs asynchronously.

## Durable Outbox
Any obligation to send a report/notification is persisted in PostgreSQL before delivery. Worker failure or Redis loss cannot remove the obligation.

## Webhook Storage Model
One HTTP batch is stored once, then split into small normalized event rows. Never store the same raw batch once per event.

Suggested conceptual model:
- `webhook_batches`: receipt metadata, hash, event count, processing status, temporary raw payload.
- `pasarguard_events`: normalized events referencing batch/id/index.
- `accounting_transactions`: immutable financial ledger.

## Raw Retention
Raw payload exists only for debugging:
- Shadow mode default: 30 days.
- Production default: 14 days.
- Owner configurable.

After expiration, raw payload is purged while hashes, receipt metadata, normalized events, processing results, and financial transactions remain.

## Idempotency
Guarantee is **at-least-once ingestion + idempotent financial processing**, not exactly-once network delivery. Batch deduplication and financial idempotency are separate concerns.

## Event Model
Fair uses auditable event ingestion and an immutable financial ledger; it is **not full Event Sourcing**. The complete application state is not reconstructed by replaying all events.

The FP-003A offline replay's PostgreSQL Testcontainers database is **disposable** and removed. It cannot be the persistent FP-003B dashboard source. Public FP-003B staging will run its **own isolated persistent PostgreSQL 17 on a separate VPS using synthetic-only events**, never querying Pasarguard/Pasarjew databases or exposing Owner private replay data. Owner/session authentication writes are permitted; financial/event-management operations remain read-only.

## Correlation
Correlation uses stable user identity, source event timestamps, relevant state changes, and a configurable time window. Default correlation window is 120 seconds, stored in Owner settings and never hard-coded. Changing it affects future correlation behavior only unless an explicit reprocessing workflow is invoked.

## Reporting
Reports aggregate accounting transactions only. They never reinterpret raw webhook payloads. Reports are versioned/revisioned and are not silently overwritten.

## Reconciliation
Pasarguard API reconciliation is intentionally **not part of v1.0**. The architecture must leave room for v1.1+ reconciliation without coupling accounting to direct Pasarguard DB access.

## Deployment
**FP-003B staging (implementation approved, not yet deployed):** a dedicated public VPS, Dockerized Caddy (only published TCP/443), Next.js Web, separate NestJS/Fastify Owner API mode (no webhook routes), and persistent PostgreSQL 17 on private Docker networks. Cloudflare is DNS-only; TLS-ALPN-01 on TCP/443 with TCP/80 closed; SSH key-only TCP/22 remains for human operations/SSH-based GitHub Actions staging deployment. UFW rules are intentionally simple; private containers publish **no** host ports because Docker publishing can bypass UFW. No live Pasarguard webhook/worker or financial posting. See [runbook](deployment/FP-003B-staging-runbook.md).

**Later production topology (not authorized by FP-003B):** the previously proposed isolated stack on the Pasarguard VPS (`fair-api`, `fair-worker`, `fair-web`, `fair-postgres`, optional `fair-redis`) remains a **separate later deployment decision**, with verified upstream webhook authentication, financial shadow cutover, HAProxy and release review. Fair PostgreSQL must remain separate from Pasarguard/TimescaleDB.

## Observability
Expose `/health/live` and `/health/ready`. Metrics include webhook intake/failures, processing latency, pending events, accounting exceptions, missing pricing, report/delivery failures, DB latency, and retention cleanup.

## Failure Philosophy
Technical success is not business success. If required state is missing or semantics are ambiguous, processing must create an explicit exception instead of silently choosing zero financial effect.

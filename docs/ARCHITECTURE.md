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

## Correlation
Correlation uses stable user identity, source event timestamps, relevant state changes, and a configurable time window. Default correlation window is 120 seconds, stored in Owner settings and never hard-coded. Changing it affects future correlation behavior only unless an explicit reprocessing workflow is invoked.

## Reporting
Reports aggregate accounting transactions only. They never reinterpret raw webhook payloads. Reports are versioned/revisioned and are not silently overwritten.

## Reconciliation
Pasarguard API reconciliation is intentionally **not part of v1.0**. The architecture must leave room for v1.1+ reconciliation without coupling accounting to direct Pasarguard DB access.

## Deployment
Initial topology on the existing VPS:
- `fair-api`
- `fair-worker`
- `fair-web`
- `fair-postgres`
- optional `fair-redis`

Fair PostgreSQL is separate from Pasarguard/TimescaleDB.

## Observability
Expose `/health/live` and `/health/ready`. Metrics include webhook intake/failures, processing latency, pending events, accounting exceptions, missing pricing, report/delivery failures, DB latency, and retention cleanup.

## Failure Philosophy
Technical success is not business success. If required state is missing or semantics are ambiguous, processing must create an explicit exception instead of silently choosing zero financial effect.

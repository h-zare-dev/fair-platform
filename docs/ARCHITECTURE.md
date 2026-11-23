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

Feature order and authorization are documented in [`ROADMAP.md`](ROADMAP.md). FP-001/001B ingestion, FP-002 SHADOW ledger and FP-003A replay are distinct. FP-003B is an **Owner-reported activated** public HTTPS, authenticated, synthetic-only STAGING dashboard with protected automated release delivery, **not** a financial classifier. FP-004 adds synthetic pricing-configuration writes; the Owner-approved 2026-11-19 group/package/nightly accounting design is **not implemented**. See [current state and ADR overrides](CURRENT_STATE_AND_POLICY_2026-11-19.md).

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

The FP-003A offline replay's PostgreSQL Testcontainers database is **disposable** and removed. It is separate from public FP-003B Staging's isolated persistent PostgreSQL 17 on another VPS with synthetic-only events. Owner/session **and FP-004 synthetic pricing configuration** writes are permitted and audited; actual charge posting, live webhook processing and real source financial data are **not**. The proposed read-only real Pasarguard admin directory is separately approval/credential gated and may fetch only admin IDs/usernames through official API, never the upstream database.

## Correlation
Correlation uses stable user identity, source event timestamps, relevant state changes, and a configurable time window. The Owner-corrected default for the non-posting FP-006/007 replay is 600 seconds (allowed 1–600), configured through the application environment, not a hard-coded event-time threshold. Changes to the window do not rewrite completed financial history; the existing replay explicitly recomputes a hypothetical preview.

## Reporting
**Approved future architecture, not current Worker implementation:** receive and normalize webhooks durably as they arrive, but perform **no financial pricing/ledger posting during the day**. A configurable nightly job freezes each admin's **end-of-day local group/pricing context**, correlates verified operations, and posts immutable per-admin/day transactions and a daily snapshot in a single idempotent closure. An unresolved exception holds **only that date**; later dates may independently finalize/send. Weekly/monthly reports aggregate only finalized daily amounts and wait for all constituent days, without revisiting current pricing or raw events. Delivered/finalized reports are not silently overwritten, regenerated or re-rated; explicit future adjustments need a new audited record. See [nightly design](tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md).

## Reconciliation
Pasarguard API reconciliation is intentionally **not part of v1.0**. The architecture must leave room for v1.1+ reconciliation without coupling accounting to direct Pasarguard DB access.

## Deployment
**FP-003B staging (Owner reports Persian dashboard active):** dedicated public VPS, Dockerized Caddy (only published TCP/443), Next.js Web, separate NestJS/Fastify Owner API (no webhook routes), persistent synthetic PostgreSQL 17 on private Docker networks. Cloudflare DNS-only, TLS-ALPN-01 on TCP/443, TCP/80 closed. **ADR 0016** authorizes protected-Environment root-password SSH bootstrap and an ephemeral restricted deploy key for this disposable VPS, superseding ADR 0015's key-only target **in Staging only**. **ADR 0017** removes automatic backup/restore from this VPS; losing synthetic data may be irreversible. UFW rules remain simple; private containers publish **no** host ports because Docker publishing can bypass UFW. No live webhook or financial posting. See [runbook](deployment/FP-003B-staging-runbook.md).

**Later production topology (not authorized by FP-003B):** the previously proposed isolated stack on the Pasarguard VPS (`fair-api`, `fair-worker`, `fair-web`, `fair-postgres`, optional `fair-redis`) remains a **separate later deployment decision**, with verified upstream webhook authentication, financial shadow cutover, HAProxy and release review. Fair PostgreSQL must remain separate from Pasarguard/TimescaleDB.

## Observability
Expose `/health/live` and `/health/ready`. Metrics include webhook intake/failures, processing latency, pending events, accounting exceptions, missing pricing, report/delivery failures, DB latency, and retention cleanup.

## Failure Philosophy
Technical success is not business success. If required state is missing or semantics are ambiguous, processing must create an explicit exception instead of silently choosing zero financial effect.

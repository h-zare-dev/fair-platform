# FP-001 — Durable Pasarguard Webhook Ingestion

Status: Approved for implementation
Target branch: `feature/fp-001-pasarguard-webhook-ingestion`
Merge target: `development`
PR mode: Draft until all merge gates pass

## Goal
Build the first real Fair Platform vertical slice: receive Pasarguard webhooks, durably persist each batch once in PostgreSQL, asynchronously normalize child events, and expose normalized events ready for future accounting. No accounting or pricing is implemented in FP-001.

## Required reading
Before coding, read:
- `AGENTS.md`
- `agents/feature-lifecycle.md`
- `agents/implementation.md`
- `docs/PROJECT_BLUEPRINT.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_RULES.md`
- `docs/integrations/PASARGUARD.md`
- `docs/CODING_STANDARDS.md`
- `docs/TESTING_POLICY.md`
- `docs/SECURITY_POLICY.md`
- `docs/DEFINITION_OF_DONE.md`
- ADR 0002, 0004, 0008, 0010, 0011, 0012, 0014

## Approved wire-contract input for FP-001
Read `docs/integrations/PASARGUARD_WEBHOOK_WIRE_CONTRACT.md` and the synthetic fixtures under `tests/fixtures/pasarguard/` before implementing the parser, normalizer, or contract tests. Observed legacy array fields and timestamp units are mapped there. A top-level singleton is a supported FP-001 compatibility form, not separately proven source traffic. An unverified `next_plan` object or a new wrapper must never be silently guessed. Current production upstream envelope/authentication must be verified before activation.

## In scope
- `POST /api/v1/webhooks/pasarguard`
- top-level Zod validation
- webhook-authenticator abstraction; production must fail closed until the actual Pasarguard auth mechanism is configured
- PostgreSQL/TypeORM data source and first real migrations
- durable batch inbox
- deterministic canonical JSON + SHA-256 batch hash
- AES-256-GCM encryption of short-lived raw payloads using `APP_ENCRYPTION_KEY`
- configurable raw retention (`RAW_WEBHOOK_RETENTION_DAYS`, default 14)
- normalized Pasarguard events
- semantic event fingerprinting and duplicate collapse
- PostgreSQL worker claiming with transaction + `FOR UPDATE SKIP LOCKED`
- retry-safe normalization
- ingestion issues for invalid/unknown child events
- sanitized logs
- Testcontainers PostgreSQL integration tests and E2E coverage
- documentation updates required by implementation

## Out of scope
Accounting, pricing, reports, Telegram, Owner/Admin UI, reconciliation, Redis queues, BullMQ, NATS, RabbitMQ, Kafka, Sales/Customer features, production deployment, and any new architecture decision.

## HTTP behavior
Endpoint: `POST /api/v1/webhooks/pasarguard`

- Valid new batch after PostgreSQL commit: `202 {"accepted":true}`
- Recognized duplicate batch: same successful `202`
- malformed top-level request: `400`
- authentication failure: `401` or `403`
- database failure before durable commit: `5xx`

No success acknowledgement before the durable database transaction commits. The HTTP request must not perform accounting, pricing, Telegram, reporting, or long-running normalization work.

## Source identity
Add configuration `PASARGUARD_SOURCE_INSTANCE_ID`, defaulting to `primary` for development. External identities remain source-aware.

## Table: `pasarguard_webhook_batches`
Required conceptual columns:
- `id BIGINT identity PK`
- `source_instance_id VARCHAR(100) NOT NULL`
- `received_at TIMESTAMPTZ NOT NULL`
- `payload_hash CHAR(64) NOT NULL`
- `event_count INTEGER NOT NULL`
- `processing_status VARCHAR(32) NOT NULL`
- `processing_attempts INTEGER NOT NULL DEFAULT 0`
- `last_processing_at TIMESTAMPTZ NULL`
- `last_error_code VARCHAR(64) NULL`
- `last_error_message TEXT NULL`
- `raw_payload_ciphertext BYTEA NULL`
- `raw_payload_iv BYTEA NULL`
- `raw_payload_auth_tag BYTEA NULL`
- `raw_payload_key_version SMALLINT NULL`
- `raw_payload_expires_at TIMESTAMPTZ NULL`
- `raw_payload_purged_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

Constraints/indexes:
- unique `(source_instance_id, payload_hash)`
- index `(processing_status, received_at)`
- index `raw_payload_expires_at`

No GIN/full-text/search index over raw payload data.

## Batch state machine
Allowed states:
- `RECEIVED`
- `NORMALIZING`
- `NORMALIZED`
- `FAILED_RETRYABLE`
- `FAILED_PERMANENT`

Normal flow: `RECEIVED -> NORMALIZING -> NORMALIZED`.
Retryable failures may return to `NORMALIZING`. Unknown states must not be silently accepted.

## Raw payload rules
A Pasarguard batch is stored exactly once as one encrypted raw batch. Never duplicate the whole batch JSON per child event. Raw sensitive data must not be logged or copied into searchable normalized fields.

Encryption:
- Node `crypto`
- AES-256-GCM
- independent nonce/IV per payload
- authentication tag persisted separately
- `raw_payload_key_version = 1` initially
- invalid/missing production encryption configuration fails closed

Retention:
- default 14 days
- configurable, not a business hard-code
- only calculate/store expiry in FP-001; purge job is out of scope

## Table: `pasarguard_events`
Required conceptual columns:
- `id BIGINT identity PK`
- `batch_id BIGINT NOT NULL FK`
- `batch_index INTEGER NOT NULL`
- `source_instance_id VARCHAR(100) NOT NULL`
- `semantic_fingerprint CHAR(64) NOT NULL`
- `action VARCHAR(64) NOT NULL`
- `external_user_id BIGINT NOT NULL`
- `username VARCHAR(255) NOT NULL`
- `user_status VARCHAR(64) NOT NULL`
- `data_limit_bytes BIGINT NOT NULL`
- `used_traffic_bytes BIGINT NOT NULL`
- `lifetime_used_bytes BIGINT NOT NULL`
- `billing_admin_id BIGINT NOT NULL`
- `billing_admin_username VARCHAR(255) NOT NULL`
- `actor_admin_id BIGINT NULL`
- `actor_admin_username VARCHAR(255) NULL`
- `source_enqueued_at TIMESTAMPTZ NOT NULL`
- `source_send_at TIMESTAMPTZ NULL`
- `reset_strategy VARCHAR(64) NULL`
- `next_plan_data_limit_bytes BIGINT NULL`
- `next_plan_expire TIMESTAMPTZ NULL`
- `event_status VARCHAR(32) NOT NULL`
- `first_seen_at TIMESTAMPTZ NOT NULL`
- `last_seen_at TIMESTAMPTZ NOT NULL`
- `occurrence_count INTEGER NOT NULL DEFAULT 1`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

Indexes/constraints:
- unique `(source_instance_id, semantic_fingerprint)`
- index `(external_user_id, source_enqueued_at)`
- index `(billing_admin_id, source_enqueued_at)`
- index `(action, source_enqueued_at)`
- index `(event_status, source_enqueued_at)`

Do not normalize/store subscription URLs, proxy credentials/configs, VLESS/VMess/Trojan/WireGuard/Hysteria/Shadowsocks secrets, or equivalent sensitive connection material.

## Event status
FP-001 may use:
- `READY_FOR_ACCOUNTING`
- `IGNORED_NON_FINANCIAL`
- `NEEDS_REVIEW`

`READY_FOR_ACCOUNTING` means normalized and valid for downstream processing; it does not mean a charge exists.

## Supported actions
Normalize known actions observed/defined by Pasarguard:
- `user_created`
- `user_updated`
- `user_deleted`
- `user_limited`
- `user_expired`
- `user_enabled`
- `user_disabled`
- `data_usage_reset`
- `subscription_revoked`
- source quirk `data_reset_by_next`

Unknown child actions must not reject the whole batch. Preserve enough safe metadata to create a review issue and continue processing valid siblings.

## Table: `pasarguard_ingestion_issues`
Required conceptual columns:
- `id BIGINT identity PK`
- `batch_id BIGINT NOT NULL FK`
- `batch_index INTEGER NULL`
- `issue_code VARCHAR(64) NOT NULL`
- `issue_message TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `resolved_at TIMESTAMPTZ NULL`

Indexes:
- `batch_id`
- `(issue_code, created_at)`

Issue messages must be sanitized and must not contain raw credentials/secrets.

Initial issue codes:
- `INVALID_EVENT`
- `UNKNOWN_ACTION`
- `NORMALIZATION_FAILED`
- `INVALID_SOURCE_TIMESTAMP`
- `MISSING_REQUIRED_FIELD`
- `DUPLICATE_EVENT`

## Hashing and deduplication
Batch hash:
1. deterministically canonicalize JSON
2. UTF-8 encode
3. SHA-256
4. lowercase 64-character hex

Semantic fingerprint is distinct from batch hash and identifies a logical event. It must deterministically include at least:
- source instance
- external user id
- normalized action
- source enqueued timestamp
- data limit
- used traffic
- billing admin id
- user status
- reset strategy

When the same logical event reappears, do not create another downstream event row. Increment `occurrence_count` and update `last_seen_at`. This is event deduplication only; future financial idempotency will be an independent defense.

## Timestamp policy
Preserve both:
- `received_at`: Fair Platform HTTP receipt time
- `source_enqueued_at`: Pasarguard event time

Future correlation/business chronology uses source time, not receipt time. Do not assume HTTP delivery order equals source order.

## Worker
PostgreSQL is queue authority for FP-001. Redis must not be used.

Claim work using a short TypeORM transaction and PostgreSQL row locking equivalent to `FOR UPDATE SKIP LOCKED`. Two workers must not normalize the same batch concurrently.

No external HTTP/API/Telegram calls, sleeps, or long network operations inside the transaction.

Configuration:
- `WEBHOOK_NORMALIZATION_MAX_ATTEMPTS`, default `5`
- `WEBHOOK_WORKER_POLL_INTERVAL_MS`, default `1000`

Gracefully handle SIGTERM/SIGINT and allow transactions to roll back safely on shutdown.

## Persistence rules
- TypeORM `synchronize: false`
- real migrations mandatory
- PostgreSQL 17
- no SQLite test substitute
- domain packages must remain free of TypeORM decorators/imports

## Allowed dependencies
Existing approved stack plus, when required:
- `@nestjs/typeorm`
- `typeorm`
- `pg`
- `zod`
- `testcontainers`
- `@testcontainers/postgresql`

Use `node:crypto` for encryption/hashing. Do not add a crypto library without escalation.

Do not add BullMQ, RabbitMQ, Kafka, NATS, Prisma, MikroORM, Drizzle, a new HTTP framework, or a new validation framework. Stop and escalate if the task appears to require one.

## Required tests
At minimum automate these scenarios:
1. valid single-event webhook accepted
2. valid batch webhook accepted
3. exactly one encrypted raw batch row per delivery batch
4. a 50-event batch does not create 50 raw payload copies
5. duplicate HTTP delivery does not duplicate batch
6. duplicate logical event does not duplicate normalized row
7. duplicate logical event increments occurrence count
8. malformed top-level request returns 400
9. malformed child event does not destroy valid sibling events
10. unknown action produces review/issue behavior without losing siblings
11. raw payload is encrypted at rest
12. sensitive connection fields are absent from normalized events
13. source timestamps are preserved exactly
14. delayed delivery safely preserves distinct receipt/source times
15. two workers cannot process one batch concurrently
16. failed database transaction is not acknowledged as success
17. retryable worker failure is recoverable
18. migration works on empty PostgreSQL 17
19. restart does not lose pending work
20. expiry uses configurable retention

Use Testcontainers PostgreSQL for integration tests. Include at least one E2E flow: HTTP webhook -> durable batch -> worker -> normalized event -> `READY_FOR_ACCOUNTING`.

Fixtures must be anonymized/sanitized and contain no live credentials.

## Expected code areas
Exact filenames are implementation details, but changes should remain within approved boundaries such as:
- `apps/api/src/modules/webhooks/`
- `apps/api/src/infrastructure/database/`
- `apps/api/src/infrastructure/security/`
- `apps/worker/src/modules/pasarguard-ingestion/`
- worker database infrastructure
- `packages/pasarguard/src/schemas/`
- `packages/pasarguard/src/normalization/`
- `packages/pasarguard/src/fingerprinting/`
- `packages/pasarguard/src/types/`
- `packages/contracts/src/integration/`
- `tests/fixtures/pasarguard/`
- `tests/integration/`
- `tests/e2e/`

## Important unresolved production boundary
The exact Pasarguard webhook authentication mechanism has not yet been frozen from a verified source contract. Implement a narrow `WebhookAuthenticator` boundary and fail closed in production if no valid auth strategy is configured. Do not invent a Pasarguard header/signature protocol. This does not block the rest of FP-001 implementation or tests.

## Definition of done
FP-001 is not done until required migration, integration, E2E, duplicate, concurrency, encryption, sanitization, malformed-sibling, format, lint, typecheck, test, and build checks pass; CI is green; Review Agent has posted `REVIEW_STATUS: PASS`; QA Agent has posted `QA_STATUS: PASS`; and a human approves merge to `development`.

## Agent workflow
Follow `agents/feature-lifecycle.md` exactly.

Required lifecycle for FP-001:

`feature branch created -> Draft PR to development -> Implementation commits -> Review -> Fix commits -> Re-review -> QA -> Fix commits -> QA retest -> targeted re-review if needed -> REVIEW_STATUS: PASS + QA_STATUS: PASS + CI green -> human approval -> merge to development`

All implementation, review-fix, QA-fix, and re-verification work stays on `feature/fp-001-pasarguard-webhook-ingestion`. The branch may accumulate many commits; do not merge early merely because implementation is initially complete.

The Draft PR must remain unmerged and should remain Draft until all merge gates pass. Review and QA agents post explicit status lines in the PR conversation. Later production-code changes can invalidate an earlier PASS and require targeted re-review or retest.

Do not merge directly to `main` from this feature branch. After eventual merge to `development`, integration/operational testing happens on `development`; promotion from `development` to `main` is a separate human-approved PR.

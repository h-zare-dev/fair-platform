# FP-001 implementation and local operation

The approved scope is durable ingestion and normalization only. `READY_FOR_ACCOUNTING` denotes a valid projection awaiting future accounting; no charge, pricing decision, correlation or notification is produced.

## Evidence and production gate

The approved [wire contract](../integrations/PASARGUARD_WEBHOOK_WIRE_CONTRACT.md) remains the field-mapping authority. Synthetic fixtures reproduce observed legacy nesting, not verified current HTTP traffic. Arrays are observed; singleton objects are compatibility behavior. Wrapper envelopes are rejected. `data_reset_by_next` is supported as instructed, without claiming its direct emission was observed.

Production API startup fails closed because no verified upstream authenticator is implemented. The application `WebhookAuthenticator` port allows a future verified strategy without inventing a header/signature scheme. The default development authenticator also denies requests. An explicit `PASARGUARD_ALLOW_UNAUTHENTICATED_DEVELOPMENT=true` enables acceptance only in development/test. Never use that bypass for real webhook activation. Current deployed envelope, authentication, and non-null Next Plan evidence must be checked before production enablement.

Non-null `next_plan` is not mapped. A valid safe projection becomes `NEEDS_REVIEW` and creates a sanitized `INVALID_EVENT` issue. Unknown actions produce `UNKNOWN_ACTION` issues referencing batch/index without copying source values. Other malformed children produce safe issues while valid siblings proceed. All supported, fully validated actions become `READY_FOR_ACCOUNTING`; FP-001 makes no financial classification.

## Runtime and migrations

Shared integration infrastructure lives under `packages/pasarguard/src/infrastructure/`. It serves the separate API and worker processes; TypeORM never enters the pure normalization layer or accounting/pricing domains. Package exports use compiled JavaScript so production Node processes work without a TypeScript loader.

1. Install the locked dependencies with `pnpm install --frozen-lockfile`.
2. Configure the existing PostgreSQL 17 development stack and environment. Runtime processes consume environment variables; export values through your normal environment loader.
3. Supply `APP_ENCRYPTION_KEY` as exactly 64 hexadecimal characters representing 32 random bytes. No fallback key is generated. Keep this key outside Git and preserve it for retained batches. Key version is 1; rotation tooling is out of scope.
4. Build: `pnpm build`.
5. Apply the migration: `pnpm --filter @fair-platform/pasarguard migration:run`.
6. Start API and worker with their package `start` scripts, or use `pnpm dev` after building the shared integration package. When editing that package, rebuild it before restarting consumers.

Migration `PasarguardInbox1790000000000` creates the three task tables, identity primary keys, source-scoped unique keys, batch/event state checks, foreign keys and required B-tree indexes. Its rollback drops the three tables and is destructive; use only for disposable local/test databases. Schema synchronization and automatic startup migrations are disabled. The explicit migration runner applies migrations transactionally. `/health/live` and `/health/ready` report process and database connectivity.

## Storage, timestamps and recovery

One original logical JSON payload is canonicalized, hashed and encrypted per unique source/hash. A singleton remains a singleton for hash/encrypted retention. Child rows contain only allowlisted fields and point at their first batch/index. AES-256-GCM uses independent 12-byte IVs, separate authentication tags and authenticated decryption. Duplicate batches receive the same successful response without another storage row. Success follows transaction commit.

Traffic/identity numeric inputs must be nonnegative safe JSON integers; strings and unsafe numbers are rejected rather than rounded or guessed. Normalized BIGINT values use decimal strings. Numeric Unix source seconds are converted to UTC timestamp strings without going through millisecond-only Date conversion for the fractional portion. PostgreSQL TIMESTAMPTZ stores microseconds. Fingerprints include the original numeric seconds value so source events differing below the database timestamp resolution do not collapse. Precision already lost by a sender's JSON number cannot be reconstructed.

Semantic deduplication excludes send/retry metadata and includes the specification's source-aware identity fields. Duplicate child sightings increment occurrence count transactionally, maintain minimum/maximum receipt times, and create a `DUPLICATE_EVENT` issue. A sighting requiring review marks an existing duplicate `NEEDS_REVIEW`; later sightings do not clear review status.

Workers lock one pending row using `FOR UPDATE SKIP LOCKED` and hold the transaction through bounded local normalization. No external calls or polling sleeps occur inside it. A PostgreSQL savepoint rolls back every child event/issue write on failure while retaining the attempt and sanitized batch failure state. Failed batches retry up to the configured maximum; exhaustion creates `NORMALIZATION_FAILED` and `FAILED_PERMANENT`. A lost connection rolls back the whole transaction, restoring pending work without a lease or a stale committed `NORMALIZING` claim. Overlapping event fingerprints across workers are serialized by PostgreSQL uniqueness and atomic counters.

SIGTERM/SIGINT interrupts the polling delay and awaits the active transaction before closing the database. Startup, request, processing and shutdown failures expose fixed messages without source payloads or driver error text.

Retention only calculates expiry in this feature. **No purge job is implemented**, as explicitly excluded by FP-001. Operational deletion after expiry requires the future retention feature; do not claim expiry alone removes ciphertext.

## Configuration

| Variable | Default / requirement |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL |
| `APP_ENCRYPTION_KEY` | Required 64 hex characters, all environments |
| `PASARGUARD_SOURCE_INSTANCE_ID` | `primary`, max 100 characters |
| `RAW_WEBHOOK_RETENTION_DAYS` | 14, positive integer, maximum 36500 |
| `WEBHOOK_NORMALIZATION_MAX_ATTEMPTS` | 5, positive integer |
| `WEBHOOK_WORKER_POLL_INTERVAL_MS` | 1000, positive integer within Node timer range |
| `PASARGUARD_ALLOW_UNAUTHENTICATED_DEVELOPMENT` | Disabled; explicit development/test bypass only |

## Verification

`pnpm test:unit`, `pnpm test:integration`, and `pnpm test:e2e` build their backend dependencies before running. `pnpm test` runs all suites, including PostgreSQL 17 Testcontainers; Docker is required and no suite silently skips unavailable infrastructure. Tests use only synthetic values. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` are required gates. CI runs the same full suite on PR updates.

Integration tests cover migration/reversion, single encrypted storage for 50 children, batch/event duplicates, locking and competing workers, rollback/retry/exhaustion, abrupt connection loss, restart, safe fields/issues, receipt/source chronology and configurable expiry. E2E tests cover HTTP receipt through normalization, malformed envelopes/JSON, authentication denial and database failure before acknowledgement.

Independent Review and QA remain subsequent lifecycle stages. Implementation verification does not supply their PASS statuses or authorize merge/deployment.

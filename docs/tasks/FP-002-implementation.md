# FP-002 implementation and local operation

FP-002 is an independent accounting foundation under `packages/accounting`. Its domain and application exports contain only pure TypeScript contracts and validation. PostgreSQL/TypeORM code is exported separately through `@fair-platform/accounting/infrastructure`. Neither the webhook API nor ingestion worker invokes accounting.

## Contracts

`PostgresAccountingStore` implements the `ShadowLedger` and `AccountingExceptions` ports. `recordShadowCharge` accepts an explicit caller-owned operation key, Billing Admin, user, positive integer Toman amount, effective source UTC timestamp, reason code and nonempty source-event set. It never determines a classification, debtor, price or operation identity. Only SHADOW CHARGE is writable; there is no mutation, refund, adjustment or live-posting API.

Amounts and IDs are canonical decimal strings or bigint, bounded by signed PostgreSQL BIGINT. JavaScript numbers are rejected rather than coerced. External user/admin IDs accept zero consistently with FP-001; database-generated event IDs are positive. Tokens use ASCII letters, digits, underscore, dot, colon and hyphen, beginning with a letter or digit; source/key/reason maximum lengths are 100/128/64. These are opaque caller-owned identifiers, never derived from usernames, payloads or amounts. Reasons are supplied by an approved future classifier; FP-002 has no reason-classification algorithm or price lookup.

Effective timestamps use explicit UTC ISO strings (`YYYY-MM-DDTHH:mm:ss[.ffffff]Z`) with at most six fractional digits. Invalid calendar dates and finer precision are rejected. Valid values are canonicalized to six fractional digits without rounding. The PostgreSQL insert is parameterized SQL because TypeORM's timestamp insertion converts strings to millisecond `Date` values. PostgreSQL `to_char` query projections preserve microseconds on return. No floating-point money or currency conversion exists.

Each charge uses a READ COMMITTED transaction. PostgreSQL `ON CONFLICT` waits for a racing operation-key insert. A subsequent query sees the winner and its complete event set. Exact immutable-field/set replay returns `ALREADY_RECORDED` and the original record; conflicting replay raises `FINANCIAL_IDEMPOTENCY_CONFLICT`. Different operation keys remain distinct even when amounts and events match. Source and SHADOW scope are part of financial uniqueness, independent of webhook/event deduplication.

Source-event existence, source and user are checked under shared locks in the same transaction. Caller Billing Admin can differ from the normalized event's Billing Admin or actor; FP-002 makes no transfer-ownership classification. Event references are stored atomically with the transaction. Failure rolls everything back; retry with the same caller-owned key is safe, including when a client lost the commit acknowledgement.

`recordAccountingException` creates only OPEN non-financial records. Its five codes are the task's approved codes, with fixed messages and optional event/user/admin references. Caller text, raw data and additional properties are never copied. Exact replay returns the existing record; code/reference conflicts raise `ACCOUNTING_EXCEPTION_CONFLICT`. A supplied event must exist in the same source and match the user when supplied. The Billing Admin remains caller-owned. No resolution operation is provided. Domain/reference/conflict failures are fixed `AccountingError` codes; unexpected driver failures expose only `ACCOUNTING_PERSISTENCE_FAILED`, without driver text, cause or input values.

## Database and migration order

Use the existing Fair PostgreSQL 17 `DATABASE_URL`, never the Pasarguard database. No database is created by the migration runner. Build packages before running migrations:

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm --filter @fair-platform/pasarguard migration:run`
4. `pnpm --filter @fair-platform/accounting migration:run`

The accounting runner requires only `DATABASE_URL`; FP-001's runner retains its existing configuration requirements. Both explicitly run migrations in a transaction with `synchronize: false` and no automatic startup migration. FP-001 owns its original history; accounting owns `accounting_migrations`. Running accounting before FP-001 fails and rolls back, rather than silently constructing ingestion tables or a second database. Re-running either runner is idempotent.

`AccountingFoundations1791000000000` adds `accounting_transactions`, `accounting_transaction_events`, and `accounting_exceptions`, their identities, scoped uniqueness, foreign keys, checks and B-tree indexes. No FP-001 table or migration is rewritten. Ledger indexes cover source/admin/time and source/user/time; reference indexes support event foreign keys. Exceptions have source/code/time indexing. No raw payload or speculative pricing relation is stored.

PostgreSQL statement triggers reject UPDATE, DELETE and TRUNCATE on ledger rows and event links. Link insertion is permitted only in the transaction that created the ledger row, using PostgreSQL `xmin`/current transaction identity, and validates source/user references. A deferred constraint trigger requires at least one link at commit. These guards preserve the complete immutable event set after posting. Database administrators can bypass database protections; migration privileges must remain human-controlled.

Rollback is destructive and only for disposable local/test databases. The accounting migration refuses rollback unless the connection has `fair.accounting_disposable=on` explicitly set (for example with PostgreSQL connection startup option `-c fair.accounting_disposable=on`). Use TypeORM `undoLastMigration({ transaction: 'all' })` on that disposable connection. Roll back accounting before FP-001 because of the foreign keys; reapply FP-001 before accounting. There is no runtime rollback command or production activation gate in this feature.

## Verification and boundaries

`pnpm test` runs the existing FP-001 unit/integration/E2E suites and the new accounting domain/PostgreSQL 17 Testcontainers suites. Docker is required; infrastructure tests are never skipped. Fixtures are synthetic. Accounting tests cover fresh/previous-schema migration compatibility, ordering, repeat application, guarded rollback/reapply, BIGINT boundaries, microsecond preservation, immutable rows/links, exact/conflicting replays, 20 independent concurrent PostgreSQL writers, multiple events, equal-amount distinct operations, source/user reference failures, safe exception deduplication, injected first/second-link failures, connection loss and recovery, and FP-001 normalization with accounting installed.

Required quality checks are frozen installation, formatting, lint, typecheck, full tests and build. Independent Review and QA remain separate gates and are not claimed by implementation results.

No pricing, event correlation, user baseline, webhook-to-accounting binding, UI, Telegram, Pasarjew modification, deployment or live financial effect is implemented. Later classifiers must supply validated operation identity, attribution, pricing result and classification under an approved contract; this feature does not activate them.

# FP-002 — Accounting Foundations (owner/ChatGPT architecture specification)

> **Historical approved FP-002 task specification.** Accounting foundations merged to `development` via PR #27. The status and future merge checklist below describe the original approval process, not the present milestone. FP-002 is SHADOW-only, with no pricing/classifier/live financial posting. See [`ROADMAP.md`](../ROADMAP.md).

Status: Design prepared for implementation under Owner-controlled workflow
Feature branch: `feature/fp-002-accounting-foundations`
Target: `development`
PR: Draft until independent Review PASS, QA PASS, green CI, and human merge approval.

## 1. Goal and authoritative constraints

Create a small, independently testable accounting persistence foundation: an immutable financial ledger, financial-effect idempotency, and deduplicated accounting exceptions. Do not charge a real Pasarguard admin, classify events, set prices, or run accounting from the webhook worker.

Read and obey `AGENTS.md`, `docs/DOMAIN_RULES.md`, `docs/ARCHITECTURE.md`, `docs/integrations/PASARGUARD.md`, `docs/SECURITY_POLICY.md`, `docs/TESTING_POLICY.md`, `docs/CODING_STANDARDS.md`, `docs/DEFINITION_OF_DONE.md`, `agents/feature-lifecycle.md`, ADR 0002/0006/0007/0008/0009/0010/0011, and FP-001 integration code/tests.

- Money: signed PostgreSQL BIGINT-compatible *integer Toman* values, with no floating point, implicit currency conversion or rounding. Store positive amounts only for actual ledger entries. Zero-effect classifications are future audit records, not zero-valued charges.
- Traffic: original integer bytes; the Owner has explicitly selected binary 1024^3 bytes per billed/displayed GB (GiB) for future pricing. FP-002 does not compute traffic prices.
- Never guess missing prices, a missing previous user state, the effect of a reset/update combination or the upstream webhook contract. This feature makes no such classifications.
- Domain logic must remain pure TypeScript; TypeORM/PostgreSQL only in infrastructure. PostgreSQL is authoritative; Redis is not involved.
- No production access or deployment. No new HTTP route, UI, Telegram bot or new background worker for FP-002.

## 2. Boundaries and artifacts

Create a bounded accounting module, preferably `packages/accounting`, with pure domain input-validation/invariants and an application port, plus an infrastructure adapter for PostgreSQL/TypeORM. Use compiled JS exports in the workspace convention. Reuse existing tooling rather than introducing a framework.

Integrate explicit accounting migrations against the **same Fair PostgreSQL database** as FP-001, never Pasarguard's database. Prefer an independent, clearly named accounting migration history (`accounting_migrations`) and accounting migration runner if that avoids reverse dependencies from `@fair-platform/pasarguard` into accounting. Migration order must be explicit: FP-001 schema first, then accounting. An existing FP-001 migration must not be rewritten; both fresh and upgraded databases must work. Do not silently create a second production database or modify the Pasarguard DB.

The existing FP-001 `pasarguard_events` and `pasarguard_ingestion_issues` have different duties. Do not overload them as an accounting ledger or accounting exceptions table.

### 2a. `accounting_transactions`

Required conceptual fields and constraints:
- `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
- `source_instance_id VARCHAR(100) NOT NULL`
- `operation_key VARCHAR(128) NOT NULL` — an opaque **stable financial-operation identity** supplied by a future approved classifier, NOT invented from username, amount, arrival time, webhook batch ID or a single event fingerprint. For FP-002 synthetic tests provide explicitly controlled operation keys.
- `posting_scope VARCHAR(16) NOT NULL`, **only `SHADOW` permitted in FP-002**. Live financial posting must require an explicit later design, migration, release gate and human activation.
- `entry_type VARCHAR(32) NOT NULL` — in FP-002 the only callable write path is a shadow `CHARGE`. Do not add a refund/adjustment execution API or invent correction semantics. Future corrections must be append-only adjustment entries, never mutations to historical entries.
- `billing_admin_id BIGINT NOT NULL`
- `external_user_id BIGINT NOT NULL`
- `amount_toman BIGINT NOT NULL CHECK (amount_toman > 0)`
- `occurred_at TIMESTAMPTZ NOT NULL` — source/effective event time, not HTTP receipt time
- `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `reason_code VARCHAR(64) NOT NULL` — explicit approved classification supplied by caller; FP-002 does not determine the reason
- Unique `(source_instance_id, posting_scope, operation_key)`.
- Reasonable B-tree indexes for admin+occurred_at and user+occurred_at, scoped by source. No raw payload, secrets, username-dependent idempotency or speculative pricing rule FK.
- Enforce append-only ledger behavior at the PostgreSQL boundary (reject UPDATE and DELETE; also protect its immutable event links). The local destructive test/migration rollback path must remain possible only in disposable databases.

### 2b. `accounting_transaction_events`

- `transaction_id BIGINT NOT NULL REFERENCES accounting_transactions(id)`
- `event_id BIGINT NOT NULL REFERENCES pasarguard_events(id)`
- PRIMARY KEY `(transaction_id, event_id)`.
- Allows one financial effect to reference one **or several** normalized source events, for future correlation. Do not assume one webhook == one financial effect.
- FP-002 recording a normal synthetic CHARGE requires **at least one** source event. Validate all referenced events exist, belong to the same source instance and the same external user as the transaction. Never assume the *actor admin* is the debtor. Do not silently reject transfer-related source billing-admin differences as future ownership semantics need an approved classifier.
- Event links are atomic with the ledger insert and remain immutable after successful posting.

### 2c. `accounting_exceptions`

Create an accounting-specific, **non-financial** durable exception store with:
- identity PK, source instance, `exception_key` (stable caller-owned idempotency identity), `exception_code`, nullable event/user/admin references as appropriate, a fixed sanitized message/code, created timestamp, status/optional resolution metadata for later Owner workflow;
- unique `(source_instance_id, exception_key)`;
- exactly the rule-defined initial codes: `PRICING_MISSING`, `UNEXPECTED_UNLIMITED`, `PREVIOUS_STATE_MISSING`, `AMBIGUOUS_CORRELATION`, `UNKNOWN_WEBHOOK_EVENT`. Future additions require an approved contract amendment.
- No raw webhook fields, secret-bearing data, uncontrolled free-text payloads or artificial zero-amount ledger rows.
- FP-002 provides only a safe, idempotent OPEN-recording operation. Owner resolution workflows belong to later features. On duplicate key with conflicting code/references, raise a safe conflict rather than silently rewriting an issue.

## 3. Domain/application contracts

- Validate source, operation/exception identity, user/admin IDs, event IDs, timestamp, reason and amount *before* persistence. Money values are canonical integer decimal strings or bigint; never coerce unsafe JS numbers. Enforce the signed 64-bit bound. Reject zero, fractional, negative, overflow, null and unsafe numeric inputs.
- The caller passes the `operation_key` and source event references explicitly. **Do not implement a financial-operation key inference algorithm in FP-002.** For correlated reset+update, the future FP-007 correlation classifier will provide a single stable identity. For two distinct same-amount changes it must provide different identities.
- Implement a transactional `recordShadowCharge` port (and a separate safe `recordAccountingException` port). Keep business domain code independent of TypeORM/NestJS.
- Transactionally insert the ledger and event links. On exact replay with same scoped key and identical immutable fields/event set, return an explicit `ALREADY_RECORDED` outcome with the original row. On same key with any conflicting immutable value, fail with sanitized `FINANCIAL_IDEMPOTENCY_CONFLICT`; do not edit, add an extra charge, or silently report success.
- Use database unique constraints and concurrency-safe PostgreSQL handling, including two workers racing with the same key. Failed source reference, DB error or crash must never commit a partial ledger entry or orphan link.
- For exceptions, exact duplicate is a no-op returning existing; conflicting replay is an explicit sanitized error. Exceptions never automatically post money.
- Verify source-event references via the existing FP-001 schema in the same transaction.
- Read/query methods may be minimal and internal, useful for future FP-003 UI and tests; do not build web endpoints now.

## 4. Explicitly out of scope

- No binding to the actual API webhook receiver or ingestion Worker; FP-001 continues to normalize only.
- No `user_created` automatic charge, no update delta, reset/Next Plan logic, state baseline, admin-transfer calculation, pricing engine, multi-currency, reports, CSV, Telegram or Owner UI.
- No live payment/collectible posting or hidden migration of historical Pasarjew finances.
- No attempt to determine a real Pasarguard HTTP authenticator, deploy to production or modify Pasarjew.
- No new Redis/messaging infrastructure.
- No spontaneous change to the domain rules or conversion basis.

## 5. Required tests and verification

Use synthetic fixtures, Vitest and PostgreSQL 17 Testcontainers. Cover:
1. Clean FP-001 → FP-002 migration; repeat migration idempotently; supported previous-schema upgrade; disposable rollback/reapply.
2. Ledger records correct source/user/admin, precise positive BIGINT Toman amount, source UTC time and immutable source-event link.
3. PostgreSQL rejects UPDATE/DELETE on posted transactions and links; application exposes no mutation APIs.
4. Same exact operation replay repeatedly returns `ALREADY_RECORDED`, row count remains one.
5. At least 20 concurrent same-key attempts commit exactly one entry and its correct links (no isolated test pretending to be a database race).
6. Same key but different amount/admin/user/event set/time/reason → explicit conflict, no mutation or duplicate charge.
7. Two distinct operation keys with same user/amount → two valid records.
8. Two source events for a single operation → exactly one transaction with two links.
9. Cross-source/user source-event references and nonexistent event IDs fail atomically.
10. Invalid money (0, negative, fraction, unsafe Number, overflow, malformed decimal) and invalid identifiers/timestamps rejected.
11. Exception creation, exact-replay idempotency, conflicting replay, all approved exception codes, no financial insert.
12. An injected failure between transaction insert and event linking leaves no partial transaction.
13. FP-001 existing ingestion/normalization tests and API/worker unchanged in observable behavior.
14. Frozen-lockfile installation, format, lint, typecheck, full tests and builds succeed. Ensure existing test fixtures/migration tests account for any new FK dependencies.
15. No real data, credentials, proxy/subscription URLs or raw payload copied to exceptions, accounting tables, logs or tests.

## 6. Definition of Done / handoff

- Implementation is confined to `feature/fp-002-accounting-foundations`, in its existing Draft PR to `development`.
- Self-contained migration and operational instructions documented in English.
- No unapproved architecture/business decisions; if the precise storage/transaction strategy above proves incompatible with current repository behavior, STOP and ask the Owner/ChatGPT for a design decision before deviating.
- All 15 verification groups pass with full CI `quality`.
- Independent Review Agent and QA Agent statuses PASS, human approval before merge.
- No automatic promotion to main, no production deployment.

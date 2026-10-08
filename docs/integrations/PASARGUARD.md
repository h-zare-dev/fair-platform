# Pasarguard Integration Contract

## Scope
v1.0 integrates with one Pasarguard instance through official Webhooks and API. Fair never depends on or modifies Pasarguard database schema.

## Source Identity
Fair assigns its own `source_instance_id`. External identity is `(source_instance_id, pasarguard_user_id)` and similarly for admins. v1.0 exposes only one source, but schema remains future-ready.

`PASARGUARD_BASE_URL` is deployment configuration.

## Webhooks
FP-001 field-level wire mapping and synthetic fixtures: [`PASARGUARD_WEBHOOK_WIRE_CONTRACT.md`](PASARGUARD_WEBHOOK_WIRE_CONTRACT.md). It distinguishes legacy stored-payload evidence from compatibility decisions and unverified current upstream HTTP behavior. Read it before implementing the FP-001 parser/normalizer.

Webhooks are the primary realtime input in v1.0. Receiver requirements:
1. Authenticate request.
2. Accept supported Pasarguard batch/singleton envelope variants where required.
3. Persist the HTTP batch once in PostgreSQL.
4. Commit before acknowledging success.
5. Split/process events asynchronously.

## Batch Behavior
Production forensics observed batches up to 50 events. Legacy Pasarjew stored the full batch repeatedly for each logical event; Fair must never repeat this pattern.

Store one raw batch, then N normalized event rows referencing `batch_id` and event index.

## Observed Event Actions
Production history contained:
- `user_created`
- `user_updated`
- `user_deleted`
- `user_limited`
- `user_expired`
- `user_enabled`
- `user_disabled`
- `data_usage_reset`
- `subscription_revoked`

Pasarguard source also defines `data_reset_by_next`. Current upstream behavior has shown a quirk where Next Plan reset can surface as `data_usage_reset`; financial semantics must therefore never depend on action string alone.

## Required Billing-Relevant Projection
Normalize only required fields, such as:
- source/external user ID
- username for display/reference
- billing admin ID
- actor admin ID when present
- action
- source timestamp / `enqueued_at`
- status
- data limit
- used/lifetime traffic when relevant
- created/edit/expire timestamps when relevant
- reset strategy
- Next Plan billing-relevant fields when present

Do not persist proxy credentials or subscription secrets in normalized business tables.

## Timestamps
Persist application timestamps in UTC `TIMESTAMPTZ`. Correlation uses source event time, not HTTP receive time. Production observations showed delivery latency can be materially larger than the reset/update semantic gap.

## Batch Deduplication
Store a deterministic batch payload hash for detecting repeat deliveries/storage duplication. Raw batch deduplication is not a substitute for event/financial idempotency.

## Financial Idempotency
Processing is designed for at-least-once delivery. Reprocessing the same logical financial event must not create duplicate accounting effects. Exact key implementation is chosen from stable source fields and canonical fingerprints and is covered by contract tests.

## Ordering and Correlation
Event ordering cannot be assumed. Correlation is scoped to stable user identity, state semantics, and the Owner-configurable correlation window (default 120 seconds). The setting must not be hard-coded.

## Actor vs Billing Admin
`by`/actor may differ from `user.admin`. Use Billing Admin for financial ownership and Actor Admin for audit.

## Automatic Reset
Actual reset events are billable according to Domain Rules; merely configuring reset strategy is not.

## Next Plan
Configuration is not billable. Activation/application is billable according to the resulting plan. Upstream action labeling may be imperfect, so inspect state/context rather than trusting action alone.

## Delete / Auto Delete
Deletion has no refund in v1.0. System auto-delete is audit-only for finance.

## Raw Payload Retention
Raw payload is debugging material, not permanent business history.
- Shadow default: 30 days.
- Production default: 14 days.
- Owner configurable.

After retention, purge raw payload while retaining batch hash/metadata, normalized events, and financial/audit data.

## Sensitive Fields
Never log or normalize sensitive fields such as subscription URLs, VLESS/VMess identifiers when secret-bearing, Trojan/Shadowsocks passwords, Hysteria auth, WireGuard private keys, API tokens, webhook secrets, or equivalent credentials.

## Unknown Events
Persist safely, mark unsupported/unknown, and alert/route to exception handling. Do not silently drop authenticated data because Pasarguard added a field/action.

## Reconciliation
Automated Pasarguard API reconciliation is **not part of v1.0**. It is planned for v1.1+ as an additional correctness safety net. v1.0 reliability relies on durable webhook ingestion, idempotent processing, observability, exceptions, and shadow-mode validation.

## Multi-Webhook Shadow Mode Quirk
Pasarguard can have multiple webhook endpoints and current behavior may consider a batch delivered if any endpoint succeeds. During shadow mode, compare Fair and Pasarjew event/accounting outputs and treat delivery discrepancies as rollout findings. NATS is not required for Fair v1.0.

## Historical Production Findings
Legacy Pasarjew analysis showed:
- large permanent raw payload storage dominated DB size;
- raw JSON GIN indexing added substantial storage;
- full batch payloads were duplicated across logical event rows;
- most reset/update plan changes occurred very close in source time;
- actor and billing admin can differ;
- silent previous-state ambiguity existed in legacy processing.

These findings motivate, but do not override, the explicit rules in `DOMAIN_RULES.md`.

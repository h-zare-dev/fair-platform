# Fair Platform — FP-001 Pasarguard Webhook Wire Contract

Status: **Approved FP-001 implementation input, grounded in observed legacy Pasarjew records**.
Applies to: `docs/tasks/FP-001-pasarguard-webhook-ingestion.md`.
Evidence: historical, user-provided, production-derived `webhook_events.raw_payload` excerpts from the Pasarjew database, inspected in September 2026. **The original records are private and must never enter this repository.**

## Evidence boundary: observed vs. compatibility vs. unknown

**Observed in stored legacy raw payloads:**
- `raw_payload` is a top-level **nonempty JSON array of event objects**; examples included batches with one or multiple events, and historical analysis measured a maximum of 50.
- Each event has `user` (object), `action` (string), `enqueued_at` (number, Unix **seconds** with fractional part), `send_at` (number, Unix **seconds** with fractional part), and a top-level `username` string.
- `user.id`, `user.username`, `user.status`, `user.admin.id`, `user.admin.username`, `user.data_limit`, `user.used_traffic`, `user.lifetime_used_traffic`, `user.data_limit_reset_strategy`, `user.next_plan`, `user.created_at`, `user.expire`, and `user.edit_at` were seen.
- `by` is either `null` or an admin-like object including `id` and `username`. It is **not** equivalent to `user.admin`.
- `user.next_plan` was **null in the inspected excerpts**. Its non-null object structure was **not established**.
- `user.created_at` and `user.expire` were ISO-like UTC datetime strings ending in `Z` in inspected examples; `user.edit_at` could be `null`.
- The historical records also contain fields with connection credentials, so raw production samples must never be added to tests or documentation.

**FP-001 compatibility decision already approved by the task (not independent evidence of upstream HTTP behavior):**
- Receiver accepts either one event object **as a top-level singleton** or a nonempty top-level JSON array of event objects. Internally, normalize the singleton to one child event while preserving the original received payload for hashing/encrypted retention. Batch indices are zero-based.
- Child-level invalid content in a well-formed array is isolated and recorded as an ingestion issue; other valid siblings proceed. Unknown action is an issue/review outcome, not a whole-batch rejection.
- JSON envelopes with additional wrapper keys (e.g. `events`, `notifications`, `data`) are **not confirmed by this evidence** and are not silently accepted or invented. Unexpected top-level shape is a 400 unless a future verified contract amendment approves it.
- This document freezes the field mapping and validation behavior **for the inspected shape and synthetic FP-001 tests**; it does **not** prove every deployment/version of Pasarguard emits exactly this HTTP body.

**Unverified / requires separate source evidence before production enablement:**
- Current upstream version, precise HTTP request envelope and any envelope-specific headers.
- Actual webhook authentication protocol, as already acknowledged in FP-001: keep the `WebhookAuthenticator` abstraction and fail closed in production.
- `next_plan` non-null subfield names and their representation. Do not invent `next_plan.data_limit` or `next_plan.expire` mapping.
- Whether an upstream version ever emits the action `data_reset_by_next` directly. It was seen as a `notification_enable` capability key, but not established as an action in these excerpts. Source behavior can label Next Plan resets as `data_usage_reset`.

## Input shapes and required event fields

| Source path | Observed type | FP-001 interpretation |
| --- | --- | --- |
| root | JSON array of objects | Observed legacy batch shape; singleton object also accepted by approved compatibility decision |
| `event.action` | string | Event action; support known list from FP-001, unknown action -> ingestion issue |
| `event.enqueued_at` | number | Unix seconds, potentially fractional; source event time |
| `event.send_at` | number | Unix seconds, potentially fractional; optional normalized send timestamp; not a substitute for enqueued time |
| `event.username` | string | Top-level display/reference field, not stable identity |
| `event.user` | object | User snapshot for billing-relevant projection |
| `event.user.id` | integer | External user identity scoped by `source_instance_id` |
| `event.user.username` | string | User display/reference username |
| `event.user.status` | string | User state, preserve observed string |
| `event.user.admin` | object | Billing owner/admin, not actor |
| `event.user.admin.id` | integer | Billing admin identity |
| `event.user.admin.username` | string | Billing admin username |
| `event.user.data_limit` | integer in bytes | Package traffic limit (not GB); missing/unsupported value must not become 0 |
| `event.user.used_traffic` | integer in bytes | Used traffic |
| `event.user.lifetime_used_traffic` | integer in bytes | Lifetime used traffic |
| `event.user.data_limit_reset_strategy` | string | Nullable normalized reset strategy if absent; `no_reset` observed |
| `event.user.created_at` | UTC datetime string | Source user creation time, if required later; not event chronology |
| `event.user.expire` | UTC datetime string | Source user expiry time, if required later |
| `event.user.edit_at` | datetime string or null | Optional source edit time |
| `event.user.next_plan` | null in inspected records | Map both normalized next-plan columns to null **only for source null/absent**; non-null object requires verified mapping |
| `event.by` | object or null | Actor metadata, independent of billing admin |
| `event.by.id` | integer (if object) | Actor admin ID; null when `by` is null |
| `event.by.username` | string (if object) | Actor admin username; null when `by` is null |
| `event.tries` | number | Transport retry metadata; **not** used as business identity |

### Projection to `pasarguard_events`

- `external_user_id <- event.user.id`
- `username <- event.user.username`
- `user_status <- event.user.status`
- `data_limit_bytes <- event.user.data_limit`
- `used_traffic_bytes <- event.user.used_traffic`
- `lifetime_used_bytes <- event.user.lifetime_used_traffic`
- `billing_admin_id <- event.user.admin.id`
- `billing_admin_username <- event.user.admin.username`
- `actor_admin_id <- event.by?.id ?? null`
- `actor_admin_username <- event.by?.username ?? null`
- `action <- event.action`
- `source_enqueued_at <- UTC(event.enqueued_at seconds)`
- `source_send_at <- UTC(event.send_at seconds)` when present and valid, otherwise null only if optional per accepted contract
- `reset_strategy <- event.user.data_limit_reset_strategy ?? null`
- `next_plan_data_limit_bytes` and `next_plan_expire` are null when `user.next_plan` is null/absent; **do not map non-null next-plan objects without new evidence**.
- `source_instance_id`, `batch_id`, and `batch_index` come from application/receipt context; they are **not** fields in observed source events.

Treat any missing required identity/financial projection field, unsafe numeric value, or invalid timestamp as an **invalid child event** with safe issue metadata, not an invented zero/null/default. Preserve sibling events. A non-null next-plan object with unverified shape must be flagged for review without silently computing its billing effect; do not leak the raw object to normalized tables.

## Time rules

- Convert numeric `enqueued_at` and `send_at` as **Unix seconds** (including fractional seconds), never as milliseconds. Validate finite numbers and reject invalid child timestamps with `INVALID_SOURCE_TIMESTAMP`.
- Preserve `received_at` separately; never use arrival time in place of source event chronology. Out-of-order receipt is allowed.
- `created_at`/`expire`/`edit_at` inside `user` are string source-user timestamps and are **not** substitutes for `event.enqueued_at`.
- Hash canonicalization/fingerprinting follows the FP-001 task; timestamp parsing must not silently round distinct source events into the same identity.

## Privacy and field allowlist

Normalize **only** the explicit safe billing-relevant fields above. Do not copy the entire `user`, `by`, `admin`, or other nested objects into normalized JSON columns, issue messages, error traces or logs.

Examples of **sensitive/non-allowlisted** input keys observed in original records: `subscription_url`, `proxy_settings`, proxy identifiers/passwords, administrator webhook endpoints, and connection/role/security configuration. Encrypted raw batch retention is handled separately by FP-001; even encrypted raw batches must be purged according to retention policy.

## Fixtures and provenance

All files under `tests/fixtures/pasarguard/` created for this contract are **fully synthetic**: IDs, usernames, amounts, and timestamps are invented test values; no original production JSON has been copied. They preserve only the **observed field nesting and types**.

- `single-event.sanitized.json`: supported singleton compatibility shape, synthesized from an observed array child; singleton transport itself unverified.
- `batch-events.sanitized.json`: observed array structure with two fictional events.
- `reset-update.sanitized.json`: fictional reset/update pair for ordering preservation **without any billing or correlation conclusion**.
- `malformed-event.sanitized.json`: array with one malformed child and one valid child; expected partial isolation.

## Verification gate

These inputs resolve the FP-001 **local wire-field mapping and test-fixture blocker for observed shapes**. Before real webhook activation, obtain a fresh sanitized capture or checked upstream implementation from the deployed Pasarguard version to confirm singleton/batch HTTP envelopes, authentication, and non-null `next_plan` cases. A mismatch must be escalated as a contract change; Agent must not guess.

# ADR 0018 — FP-004 Atomic Catalog, Jalali Validity and Nightly Safety Boundary

**Status: Accepted for FP-004 Phase A implementation direction on explicit Owner go-ahead, 2026-11-20. Financial cutover and unresolved cross-day details remain NOT APPROVED.**

## Context

Legacy synthetic pricing embeds mutable business meaning in `plan + version + assignment`, accepts a system default and `MIXED`, and matches fixed packages by bytes without source-proven duration. It is not suitable for the Owner's future group-based nightly accounting. The Owner approved the atomic catalog / simple Fair-local group / Jalali date-only design on 2026-11-19 and requested a separate Phase A implementation Draft PR on 2026-11-20.

## Decision in Phase A

1. A package is a stable, separately named identity with exact `BIGINT` bytes, integer duration days, integer Toman and **no validity dates**. Prior to first assignment it is correctable; afterward financial fields are permanently locked and a copy creates a distinct price identity. No visible version management, implicit default or hybrid fixed/per-GiB tier.
2. Every Billing Admin belongs to **at most one** local Fair group per source. Membership is an immediate current-state operation with immutable timestamped transfer history and no membership-date UI. Direct admin assignments are explicit exceptions, taking priority over group assignment in the **future**, independently approved settlement resolver.
3. Only tariff assignments have validity dates. Owner controls are Jalali date-only in IANA `FAIR_TIME_ZONE`, default `Asia/Tehran`; optional start defaults to current local date, optional end means unlimited, specified end is inclusive and stored as the next local midnight exclusive. Original UTC timestamps, dates and zone are persisted, not recomputed on later timezone changes.
4. Fixed package overlaps for the same `(bytes, duration_days)` on the same target conflict. Per-GiB mode conflicts with fixed mode on that target over any overlapping period. A database transaction must reject conflict even under concurrent writes. Assignment starts are immutable. Future end changes must not reach closed historical business dates and must re-check conflicts.
5. These tables and authenticated Owner UI/API are **configuration only**; no webhook receives a charge, no posting occurs in daytime, and no money moves. Old tables remain until safe synthetic migration and independently reviewed retirement. Full nightly accounting is the separate FP-005/006/007 design.
6. The real Pasarguard read-only admin picker remains unavailable until verified upstream API contract, bounded mock adapter, and separate Owner-controlled limited secret provisioning are approved. For now the new UI transparently indicates manual-ID synthetic fallback; never couple to its DB.

## Night-close boundaries that must be resolved before financial code

- At local midnight, a future night-close must reconstruct/freeze the **complete tuple** `(Billing Admin, group, effective assignment, exact package/rate, timezone, source watermark)` as of the cutoff. A mutable current assignment or price read between midnight and `02:10` must never modify the prior day. Phase A's durable audit and immutable price identities are prerequisites **but not yet a full frozen context implementation**.
- Cross-midnight Reset+Update vs distinct Create/Delete/Recreate cannot be assigned to a business date from receipt order or a bare 120-second window. The event/operation identity and owner-day mapping need source-proven semantic tests and a separately approved decision; ambiguity must fail closed, never invent a charge.
- A late source event after `FINALIZED` must be retained and surfaced, without rewriting prior daily reports or silently writing off debt. Adjustment/compensating-ledger authorization and report presentation are **open decisions** before financial rollout.
- Duration is not proven as an explicit webhook field. `created_at` and `expire` alone are not reliable duration for update/renewal. Fixed exact `(bytes,days)` matching cannot automatically bill real events until an approved, verified source-of-truth/fixture contract exists. Missing duration becomes a typed blocking exception, not a guessed 30-day plan.
- Changing IANA `FAIR_TIME_ZONE` while unsettled days or schedules are in flight requires an explicit audited **cutover rule** mapping every local date to one immutable period; do not activate such a change simply by restarting a financial scheduler. The Iranian Jalali week start and report week numbering also require an explicit decision before weekly reports. Phase A only uses timezone for **new configuration dates**, with stored UTC instants immutable.

## Consequences and verification

This ADR does **not** authorize live Pasarguard credentials, SHADOW/LIVE financial posting, legacy tariff migration or automated production deployment. Implementation is staged behind a Draft PR and CI/testcontainers migration tests, protected `development`, and human Owner Ready/Merge. The full design remains in [nightly settlement](../tasks/FP-ACCOUNTING-NIGHTLY-SETTLEMENT-DRAFT.md) but its `DRAFT` filename is kept to reflect unresolved operational semantics rather than an accidental implementation permission.

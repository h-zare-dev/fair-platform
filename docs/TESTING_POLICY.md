# Testing Policy

## Principles
Financial correctness is more important than coverage vanity metrics. Tests must target invariants, boundaries, failure recovery, retries, and historical regressions.

Follow [`ROADMAP.md`](ROADMAP.md) and the [current status/policy record](CURRENT_STATE_AND_POLICY_2026-11-19.md): offline FP-003A/FP-001B replay proves normalization/reproducibility, **not** live HTTP auth/delivery or financial correctness. The FP-003B approved original spec requires one-Owner bootstrap, Argon2id, secure session/CSRF/logout, authenticated Owner endpoints, synthetic PostgreSQL, public 443/TLS-ALPN with 80 closed, bounded API/pagination, gated GitHub release, immutable GHCR digests, serialized deployment and app-only compatible rollback. **Current disposable Staging overrides are explicit:** root-password bootstrap and ephemeral key (ADR 0016), **no automatic real VPS backup or restore** (ADR 0017). The `test:backup` CI drill remains a **synthetic integration test**, not a promise to back up that VPS. Owner reports the Persian dashboard activated; current host/image/SSH health still needs separately captured operational evidence. Passing tests does not prove financial production correctness.

## Unit Tests
Required for pure domain logic, especially Accounting, Pricing, Calendar, and Correlation.

## Integration Tests
Use real PostgreSQL through Testcontainers. Do not substitute SQLite for PostgreSQL behavior.

## Contract Tests
Maintain anonymized Pasarguard webhook/API fixtures. Validate supported actions, batch envelopes, required fields, ordering variations, unknown fields/actions, sensitive-field redaction, and upstream quirks.

## E2E Tests
Cover critical paths such as `webhook → durable inbox → worker → accounting transaction → report → formatter/delivery obligation`.

## Golden Tests
Use anonymized real business cases and later real report/CSV examples to lock exact money/traffic outcomes.

## Property-Based Tests
Use where valuable for calendar round-trips, half-open reporting periods, money invariants, idempotency, and correlation properties.

## Jalali Tests
Include month/year boundaries, Esfand/Farvardin, leap/non-leap years, invalid dates, midnight boundaries, and multi-year coverage.

The approved upcoming date-only/group/nightly accounting design additionally requires 15-year day-by-day Jalali/ICU comparison (including 31 Shahrivar and 29/30 Esfand), correct IANA timezone rules and DST, immutable end-of-day group-context snapshots and daily report periods. A running code implementation cannot be claimed from a calendar test alone.

## Mutation Testing
Use Stryker on critical domains: Accounting, Pricing, Calendar, and Correlation. It need not run on every trivial commit.

## Regression Rule
Every production or discovered bug gets a failing regression test before/with the fix.

## Migration Tests
CI must verify empty DB → migrations → boot and supported prior schema → migrations → boot.

## Coverage
Global target roughly 80–90%. Critical financial/domain modules should aim for near-complete meaningful branch coverage. A high percentage never replaces behavioral tests.

## Adversarial Cases
Tests include duplicates, retries, out-of-order events, worker crash/restart, late events, malformed payloads, missing pricing, missing prior state, unknown actions, reset/update timing boundaries, and Redis loss.

For nightly settlement add: no daytime charge posting; end-of-day group correction; same-day verified correction vs ambiguous Create/Delete/Recreate; delayed events; two days of unresolved exceptions without blocking later daily reports; held weekly/monthly periods; idempotent close, backfill and report delivery; no repricing after finalized reports.

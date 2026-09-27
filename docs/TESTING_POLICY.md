# Testing Policy

## Principles
Financial correctness is more important than coverage vanity metrics. Tests must target invariants, boundaries, failure recovery, retries, and historical regressions.

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

# ADR 0002: PostgreSQL Is the Source of Truth

## Context
Financial and delivery state must survive process/cache failures.

## Decision
Persist all critical application state in PostgreSQL 17.

## Consequences
Redis and workers may be replaced/restarted without losing financial truth.

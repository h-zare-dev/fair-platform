# ADR 0003: Redis Is Ephemeral

## Context
Redis loss must not corrupt accounting or delivery obligations.

## Decision
Use Redis only for disposable cache/rate-limit/short-lived coordination concerns.

## Consequences
Critical queues/obligations remain reconstructible from PostgreSQL.

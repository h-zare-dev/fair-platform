# ADR 0010: Transactional Inbox/Outbox

## Context
Webhook and notification obligations must survive worker/cache failures.

## Decision
Persist incoming work and outgoing delivery obligations transactionally in PostgreSQL before asynchronous execution.

## Consequences
Crash recovery and re-enqueue are deterministic and do not depend on Redis durability.

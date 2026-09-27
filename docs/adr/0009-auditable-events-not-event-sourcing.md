# ADR 0009: Auditable Events, Not Full Event Sourcing

## Context
Auditability is necessary, but rebuilding all application state from an event stream is unnecessary complexity.

## Decision
Preserve auditable normalized events and an immutable financial ledger without adopting full Event Sourcing.

## Consequences
Strong financial traceability with simpler state management.

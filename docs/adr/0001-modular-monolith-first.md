# ADR 0001: Modular Monolith First

## Context
The platform needs clear module boundaries but does not yet justify distributed-system complexity.

## Decision
Start as a modular monolith with separate API/worker/web runtime processes and extraction-ready package boundaries.

## Consequences
Lower operational complexity now; modules may be extracted later only when justified.

# ADR 0012: Short-Lived Raw Webhook Retention

## Context
Legacy Pasarjew DB growth was dominated by permanent duplicated raw webhook JSON and indexing.

## Decision
Store each raw HTTP batch once for debugging only. Default retention: 30 days in shadow mode, 14 days in production, Owner configurable. No wholesale GIN index on raw payload.

## Consequences
Debuggability remains available while backup/storage stays bounded and sensitive data exposure is reduced.

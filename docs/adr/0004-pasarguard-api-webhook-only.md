# ADR 0004: Pasarguard API and Webhook Integration Only

## Context
Direct database coupling would make upgrades unsafe and boundaries unclear.

## Decision
Integrate through official Pasarguard API/Webhooks only; never runtime-read/write Pasarguard DB schema.

## Consequences
Fair remains independently deployable and resilient to database implementation changes.

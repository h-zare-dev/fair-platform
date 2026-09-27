# ADR 0013: Shadow-Mode Cutover

## Context
Replacing an existing accounting bot without validation is financially risky.

## Decision
Run Fair beside Pasarjew for at least 7–14 days and longer if required. Compare events, financial totals, traffic, reports, and exceptions before human-approved cutover. Do not import the old financial ledger.

## Consequences
Cutover is evidence-based and rollback/reference remains possible during validation.

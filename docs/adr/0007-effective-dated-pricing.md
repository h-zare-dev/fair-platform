# ADR 0007: Effective-Dated Pricing

## Context
Pricing changes must not rewrite historical financial results.

## Decision
Pricing plans/rules are versioned/effective-dated and transactions record the pricing rule/version applied at event time.

## Consequences
Historical invoices/reports remain auditable after price changes.

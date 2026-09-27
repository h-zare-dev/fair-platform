# ADR 0006: Toman Money Model

## Context
The business operates in Toman and does not need multi-currency in v1.0.

## Decision
Use integer Toman amounts (`amount_toman` / BIGINT-compatible storage). Never float.

## Consequences
No Rial conversion ambiguity or floating-point rounding errors.

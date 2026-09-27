# ADR 0005: UTC Storage, Jalali Business Calendar

## Context
Historical reporting had boundary risks around Jalali dates.

## Decision
Persist timestamps as UTC `TIMESTAMPTZ`; define reporting in `Asia/Tehran` Jalali periods with half-open intervals `[start,end)`.

## Consequences
One canonical time source and testable business-period boundaries.

# Coding Standards

## Language
TypeScript is the application language. Domain modules remain framework-independent pure TypeScript.

## Boundaries
Controllers adapt transport only. Business logic belongs in application/domain services. Infrastructure implements persistence/integration ports.

## NestJS
Do not place accounting/pricing decisions in controllers, pipes, guards, or framework decorators.

## TypeORM
- Infrastructure only.
- `synchronize: false`.
- Migrations mandatory.
- No Active Record.
- No lazy relations.
- No uncontrolled cascades.
- Explicit transaction boundaries.
- Avoid leaking TypeORM entities/types into Domain.

## SQL
Use repositories/QueryBuilder by default. Raw SQL is allowed only when a PostgreSQL-specific constraint/index/locking/migration feature cannot be expressed cleanly otherwise; document the reason.

## Validation
Use Zod for external/boundary contracts and configuration validation where practical. Domain invariants still belong in Domain code.

## Money
Integer Toman only. Never float.

## Traffic
Canonical normalized unit is bytes using integer-safe types.

## Dates
Persist UTC timestamps. Business/report calculations use `Asia/Tehran` and the single approved Jalali period service. Use half-open intervals `[start, end)`.

## Correlation Settings
Do not hard-code the correlation window. Read the Owner-configured setting with a default of 120 seconds through an appropriate configuration/application boundary.

## Errors
Differentiate technical processing success from business resolution. Ambiguous financial state creates explicit exceptions.

## Logging
Structured logs; never log secrets, sensitive webhook fields, subscription URLs, proxy credentials, passwords, or tokens.

## Comments
Explain non-obvious invariants and reasons, not line-by-line mechanics.

## Tests
New behavior includes tests. Bugs include regression tests. Critical business logic is not considered complete without boundary/failure cases.

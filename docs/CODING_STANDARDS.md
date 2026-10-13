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

FP-002's approved pricing/display unit is binary GiB (1,073,741,824 bytes). Preserve integer bytes and represent fractional GiB quantities without floating-point money. The rounding method for any non-integral **final Toman** result is pending separate FP-004 Owner approval.

## Dates
Persist UTC timestamps. Business/report calculations use `Asia/Tehran` and the single approved Jalali period service. Use half-open intervals `[start, end)`.

## Correlation Settings
Do not hard-code the correlation window. Read the Owner-configured setting with a default of 120 seconds through an appropriate configuration/application boundary.

## Errors
Differentiate technical processing success from business resolution. Ambiguous financial state creates explicit exceptions.

## FP-003B public Owner runtime and delivery
- Keep a separate Owner-only NestJS/Fastify runtime/module from the FP-001 production webhook bootstrap; **never** remove the existing fail-closed webhook guard or enable unauthenticated development bypass on staging.
- Reuse existing TypeORM/PostgreSQL infrastructure and explicit migrations for Owner/session records; do not put application SQL or authentication in Next.js client components. Only auth/session writes are in scope; no new financial posting or ingestion business mutation.
- All Owner data API outputs use fixed allowlists, bounded filter/page sizes, cursor pagination and decimal-string BIGINT fields. Distinguish `source_enqueued_at`, `received_at` and persisted-row creation timestamps.
- Docker: use multi-stage production images, non-root runtime where feasible, immutable image digests, safe health endpoints and no internal published ports. Only Caddy TCP/443 is mapped; SSH 22 is Host OpenSSH, not a Docker service. CI deploy is protected-branch staging-only and never runs for PRs.

## Logging
Structured logs; never log secrets, sensitive webhook fields, subscription URLs, proxy credentials, passwords, session cookies/IDs, or tokens.

## Comments
Explain non-obvious invariants and reasons, not line-by-line mechanics.

## Tests
New behavior includes tests. Bugs include regression tests. Critical business logic is not considered complete without boundary/failure cases.

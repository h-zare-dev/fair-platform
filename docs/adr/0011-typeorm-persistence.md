# ADR 0011: TypeORM Persistence

## Context
The project uses NestJS/PostgreSQL and the team has prior TypeORM experience.

## Decision
Use TypeORM in infrastructure, with migrations, explicit transactions, Repository/QueryBuilder, and no ORM types in Domain.

## Consequences
Familiar persistence tooling without coupling domain logic to the ORM.

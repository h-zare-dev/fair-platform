# ADR 0014: NestJS with Fastify HTTP Platform

## Status
Accepted.

## Context
Fair Platform is a greenfield backend with a durable, low-overhead webhook ingestion path. NestJS is the application framework, but Express is only its default HTTP adapter and is not required by Fair Platform. The project has no legacy Express middleware dependency.

## Decision
The Fair Platform API uses NestJS 12 with `@nestjs/platform-fastify`. The worker uses a NestJS application context and does not expose an HTTP server. Fastify types and request/reply objects must not cross the transport boundary into application or domain code.

## Consequences
- Lower HTTP overhead and strong TypeScript/Fastify ergonomics for webhook-heavy workloads.
- Express-only middleware and Multer-specific recipes cannot be adopted without an explicit Fastify-compatible alternative.
- Domain and application layers remain HTTP-platform agnostic, preserving the ability to replace the adapter later if justified.

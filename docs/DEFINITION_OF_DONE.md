# Definition of Done

A task is Done only when all applicable conditions are met:

- Approved requirements implemented without changing business semantics.
- Architecture/module boundaries respected.
- Domain logic remains framework-independent.
- Automated tests added/updated for behavior and boundaries.
- Regression test added for every bug fix.
- Unit/integration/E2E/contract tests required by the task pass.
- Typecheck, lint, formatting, and production build pass.
- Migrations are explicit, reviewable, and tested when schema changes exist.
- Financial/idempotency/concurrency behavior reviewed when applicable.
- No secrets or sensitive payload data leaked to source/logs/fixtures.
- Documentation/ADR updated when an approved decision changed.
- Review Agent findings resolved.
- QA completed for meaningful behavior changes.
- Targeted re-review completed if QA fixes materially changed production code.
- Full CI green.
- Human approval received before merge/production.

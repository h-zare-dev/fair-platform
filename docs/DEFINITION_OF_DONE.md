# Definition of Done

A task is Done only when all applicable conditions are met:

- The task follows the milestone order in `docs/ROADMAP.md` and has an **explicitly Owner-approved detailed implementation specification**; design briefs do not grant implementation permission.

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
- Applicable Owner-controlled operational/private acceptance is complete; historical replay PASS is not financial or live-webhook acceptance.
- **Only the human Owner personally marks PRs Ready and executes Merge.** Agents/assistants perform neither action.
- Post-merge CI on the actual `development` commit succeeds before further promotion; live billing/production activation require separate approval.

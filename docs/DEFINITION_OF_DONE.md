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
- Independent **code/security review** findings resolved (human reviewer or explicitly requested interactive review; no autonomous agent required).
- Relevant QA/acceptance completed for meaningful behavior changes, with evidence from tests and review.
- Targeted re-review completed if QA fixes materially changed production code.
- Full CI green.
- Applicable Owner-controlled operational/private acceptance is complete; historical replay PASS is not financial or live-webhook acceptance.
- **Only the human Owner personally marks PRs Ready and executes Merge.** Agents/assistants perform neither action.
- Post-merge CI on the actual `development` commit succeeds before further promotion; live billing/production activation require separate approval.
- For **current synthetic-only FP-003B Staging**, require public HTTPS/Owner login, TCP 443 Caddy ACME, UFW with no private Docker ports, Owner CLI singleton, GHCR digest-pinned protected `development` deployment, pinned SSH host identity, accepted-image/migration checks, health/authenticated smoke, phone/desktop checks and compatible **app-only** fallback. **The original key-only SSH and encrypted off-host backup/restore gates were superseded for this disposable VPS**: ADR 0016 explicitly accepts protected-Environment root-password bootstrap; ADR 0017 explicitly forbids automatic actual VPS backups/restores. Isolated CI backup tests do not count as host backups. Record this staging-only high privilege and irreversible synthetic data-loss exposure; **never reuse those exceptions for live production**. PR/CI PASS alone is not current host evidence.
- The Owner reports Staging activated and personally controls future PR merges, protected host credentials and production decisions. Routine Staging deploy follows a successful reviewed Owner merge to `development`. This does not permit assistants to merge, deploy production, connect live billing webhooks or post money.

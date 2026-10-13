# Fair Platform Agent Instructions

This repository is governed by explicit architecture, domain, testing, security, and workflow documentation.

**Before any feature:** read [`docs/ROADMAP.md`](docs/ROADMAP.md) for the canonical feature sequence/current status. It is a sequencing index, not a substitute for `docs/DOMAIN_RULES.md` or an **explicitly Owner-approved** implementation-grade task spec. FP-003B public-HTTPS staging dashboard/CI-CD is NEXT (**Owner approval pending**; read `docs/tasks/FP-003B-operational-dashboard.md`, `docs/adr/0015-public-https-staging-and-controlled-delivery.md`, and the staging runbook); FP-004 Pricing, FP-005 Create accounting, FP-006 Baselines/Updates and FP-007 Reset/Next Plan follow. Do not skip or renumber milestones.

## Source of Truth Priority
When instructions conflict, use this order unless an approved task specification explicitly says otherwise:

1. `docs/DOMAIN_RULES.md`
2. `docs/ARCHITECTURE.md`
3. `docs/integrations/PASARGUARD.md`
4. `docs/SECURITY_POLICY.md`
5. `docs/TESTING_POLICY.md`
6. `docs/CODING_STANDARDS.md`
7. `docs/AGENT_WORKFLOW.md`
8. `docs/DEFINITION_OF_DONE.md`
9. Relevant ADRs under `docs/adr/`

## Mandatory Behavior
- Do not invent or change business/accounting semantics.
- Do not change architecture boundaries without explicit approval.
- Stop and escalate when a task requires a new business or architecture decision.
- PostgreSQL is the authoritative store for critical state.
- Redis is disposable infrastructure and must never be the sole owner of financial or delivery obligations.
- Domain code remains pure TypeScript and does not depend on NestJS, TypeORM, Redis, Telegram, or HTTP.
- Never log or commit secrets, subscription URLs, proxy credentials, tokens, passwords, or raw sensitive fixtures.
- Every bug fix requires a regression test.
- Production deployment and production access remain human-controlled.
- **Only the human Owner personally** marks PRs Ready and merges PRs. Assistants/agents **never** do either, regardless of CI/Review/QA or generic requests to finish.
- A normalized `READY_FOR_ACCOUNTING` event is not a financial charge. Offline replay verification does not authorize live webhook integration or billing.
- New feature implementation requires an explicit Owner-approved detailed task spec; a draft or roadmap entry alone is not authorization. **Merging the docs-only FP-003B design PR does not authorize Implementation, first deploy, host changes, or live integrations without a separate Owner go-ahead.**
- FP-003B is a dedicated PUBLIC-HTTPS but SYNTHETIC-DATA-ONLY, OWNER-AUTHENTICATED STAGING application. Future auto-deploy is allowed only after the Owner approves initial staging activation; the assistant/agents never access live host credentials or perform merges. Preserve FP-001's production webhook fail-closed guard; no unverified webhook route or live financial posting.

Agent-specific responsibilities are defined in `docs/AGENT_WORKFLOW.md` and later role files under `agents/`.

# Fair Platform Agent Instructions

This repository is governed by explicit architecture, domain, testing, security, and workflow documentation.

**Before any feature:** read [`docs/ROADMAP.md`](docs/ROADMAP.md) for the canonical feature sequence/current status and [`docs/CURRENT_STATE_AND_POLICY_2026-11-19.md`](docs/CURRENT_STATE_AND_POLICY_2026-11-19.md) for verified vs Owner-reported Staging status and the ADR 0015→0016→0017 exceptions. This index is not a substitute for `docs/DOMAIN_RULES.md` or an **explicitly Owner-approved** implementation-grade task spec. FP-003B public-HTTPS Staging was approved in October and has since been activated according to Owner evidence; FP-004 has a **synthetic** quote/editor implementation, while the revised nightly/group design is approved as direction but **not implemented**. FP-005 Create, FP-006 Baselines/Updates and FP-007 Reset/Next Plan remain future phases. Do not skip or renumber milestones.

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
- FP-003B began as a PUBLIC-HTTPS, SYNTHETIC-DATA-ONLY, OWNER-AUTHENTICATED STAGING application; the Owner subsequently enabled the read-only PasarGuard admin directory. **Explicit 2026-11-20 FP-005 exception:** the Owner permits an authenticated second PasarGuard webhook to ingest and classify *real events in SHADOW only* on this disposable existing Staging VPS, without staging backup/restore. This does **not** authorize real financial posting, settlement, Telegram delivery, changing/removing the legacy webhook, or production access. The assistant/agents are **not authorized** to use live host credentials or merge; this is a policy, **not** an OS sandbox guarantee. Preserve FP-001's production fail-closed guard and require Owner-controlled secret provisioning and Staging release checks.
- **Staging-only accepted risks:** ADR 0016 retains privileged root-password SSH bootstrap through a protected GitHub Environment; ADR 0017 supersedes its backups with **no automatic Staging backup or restore**. CI's isolated `test:backup` is **not** a host backup. Never apply these exceptions to live financial production. The Owner must still explicitly approve new implementation task specifications and any operational changes.
- **Autonomous development agents cancelled by Owner on 2026-11-19.** Do not start or rely on a local agent/orchestrator/queue; source and documents remain historical. Owner reviews Draft PRs manually with CI and independent security/code review; no active agent isolation project is required. If the Owner ever reauthorizes unattended execution, `danger-full-access` worktrees are **not** OS isolation and a credential-free separate OS account/VM is mandatory first.

The present **manual/CI workflow** is in `docs/AGENT_WORKFLOW.md`; old role files under `agents/` are historical references, not instructions to start autonomous services.

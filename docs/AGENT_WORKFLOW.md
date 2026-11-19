# Agent Workflow

## Ownership
Architecture, product scope, and business/accounting decisions are owned by the human Owner and ChatGPT design process. Execution agents do not invent those decisions.

`docs/ROADMAP.md` governs sequencing/status. The Owner explicitly approves an implementation-grade task spec before coding; draft designs alone are not authorization. **Only the human Owner personally** marks PRs Ready or executes Merge; assistants/agents never do either.

## Roles
### Implementation Agent
Implements an approved task specification, adds/updates tests, and performs local verification. It must stop/escalate if implementation exposes a new architecture/business decision.

### Review Agent
Reviews correctness, architecture boundaries, idempotency, transactions, concurrency, dates, security, financial logic, performance, and maintainability. Findings are categorized P0/P1/P2. Reviewer reports; Implementation fixes.

### QA/Test Agent
Adversarially tests edge cases, malformed inputs, duplicates, retries, races, out-of-order events, timing boundaries, missing pricing/state, recovery, and regressions. QA does not invent business rules.

## Workflow
`Roadmap check → Owner-approved Task Spec → Feature Branch → Implementation → Draft PR → CI → independent Review → fixes/re-review → independent QA → fixes/retest → green CI + applicable private Owner acceptance → Owner marks Ready → Owner merges → post-merge development CI`

## Model Selection
Do not hard-code AI model names in repository role documents. Model/effort selection belongs to orchestration because available models change over time.

## Escalation
If documentation does not determine a financial/architecture decision, stop and ask. Never fill ambiguity with an implementation guess.

## FP-003B documentation and deployment distinction
FP-003B implementation was **explicitly approved by the Owner on 2026-10-14** under the [spec](tasks/FP-003B-operational-dashboard.md) and original [ADR 0015](adr/0015-public-https-staging-and-controlled-delivery.md). The Owner now reports the public Persian synthetic Staging dashboard activated. **ADR 0016 later accepted root-password protected-Environment SSH bootstrap with an ephemeral restricted deploy key; ADR 0017 removed all automated actual Staging database backups/restores**. These decisions supersede the *Staging-only* SSH/backup expectations of the original spec; they are not production permission. A merged docs PR alone never grants a new implementation or integration approval. Current facts and risks: [status record](CURRENT_STATE_AND_POLICY_2026-11-19.md).

Review and QA must distinguish planned design from running infrastructure. They must verify PR security boundaries and, when authorized, check external IPv4/IPv6 ports, HTTPS issuance, auth enforcement, accepted SSH privilege, no-backup policy, exact image/migration identity and app-only rollback with sanctioned read-only evidence. **Do not require or attempt an actual Staging VPS backup/restore under ADR 0017.** Isolated backup/restore CI simulations remain permitted on disposable test containers. Do not ask an agent to read private replay input or production secrets. GitHub deployment secrets are for protected Staging jobs only; no PR/fork deploy. Only Owner changes Ready/Merge.

## Production
Agents have **no autonomous production SSH/deploy** authority. Public FP-003B Staging is separate from financial production; ordinary Staging auto-deployment follows human Owner merges to protected `development`. The human Owner controls credentials, host security, disaster recovery, production cutover and destructive database actions. All supervised agent `danger-full-access` execution requires **real OS/VM isolation** from production secrets before unattended operation; separate worktrees are not a sandbox. The Owner-approved 2026-11-19 nightly/group design still needs approved implementation tasks and separate Draft PRs.

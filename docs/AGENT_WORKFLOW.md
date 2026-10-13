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

## Production
No autonomous production deploy, SSH change, secret rotation, or destructive database action by agents.

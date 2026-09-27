# Agent Workflow

## Ownership
Architecture, product scope, and business/accounting decisions are owned by the human Owner and ChatGPT design process. Execution agents do not invent those decisions.

## Roles
### Implementation Agent
Implements an approved task specification, adds/updates tests, and performs local verification. It must stop/escalate if implementation exposes a new architecture/business decision.

### Review Agent
Reviews correctness, architecture boundaries, idempotency, transactions, concurrency, dates, security, financial logic, performance, and maintainability. Findings are categorized P0/P1/P2. Reviewer reports; Implementation fixes.

### QA/Test Agent
Adversarially tests edge cases, malformed inputs, duplicates, retries, races, out-of-order events, timing boundaries, missing pricing/state, recovery, and regressions. QA does not invent business rules.

## Workflow
`Approved Task Spec → Feature Branch → Implementation → local verification → Draft PR → CI → Review → fixes → CI → Review approval → QA → fixes if needed → QA retest → targeted Review when QA changed production code → full CI → Human approval → Merge`

## Model Selection
Do not hard-code AI model names in repository role documents. Model/effort selection belongs to orchestration because available models change over time.

## Escalation
If documentation does not determine a financial/architecture decision, stop and ask. Never fill ambiguity with an implementation guess.

## Production
No autonomous production deploy, SSH change, secret rotation, or destructive database action by agents.

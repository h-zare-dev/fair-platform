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
FP-003B currently has a **draft implementation-grade spec** ([spec](tasks/FP-003B-operational-dashboard.md)) and proposed [ADR 0015](adr/0015-public-https-staging-and-controlled-delivery.md). A merged docs PR or a Draft spec does not authorize editing application code; the Owner must approve the precise implementation assignment separately. The Owner chose `panel.fairisfair.ir`, public HTTPS, DNS-only Cloudflare, Docker Caddy on TCP/443, SSH key-only TCP/22, simple UFW, one Owner via CLI, persistent synthetic PostgreSQL, and GitHub Actions/GHCR/SSH automatic staging delivery after Owner merges to `development`.

Review and QA must distinguish planned design from running infrastructure. They must verify PR security boundaries and, after an Owner-authorized first staging deployment, run/check external IPv4/IPv6 port behavior, HTTPS issuance, auth enforcement, backup restore and deployment rollback with sanctioned access. Do not ask an agent to read private replay input or production secrets. GitHub deployment secrets are for protected staging job only; no PR/fork deploy. Only the Owner can change Ready/Merge.

## Production
Agents have **no autonomous production SSH/deploy** authority. Public FP-003B staging is separate from financial production; ordinary staging auto-deployment is permitted only **after the Owner explicitly authorizes initial setup/activation and merges into development**. The human Owner controls DNS/SSH key/secrets/bootstrap/first go-live, disaster recovery, production cutover, and destructive database actions.

# Fair Platform — Autonomous development lab

**Status: DESIGN / BOOTSTRAP PENDING (2026-11-14).** The GitHub issue and these documents do **not** mean the laptop runner, VPS, PasarGuard, Telegram or CI integration is installed or operating.

Tracking: [Issue #53](https://github.com/h-zare-dev/fair-platform/issues/53).

## Owner decisions

- The **Owner + ChatGPT** define scope, architectural decisions and implementation-grade Markdown specifications. ChatGPT can create/read GitHub issues and inspect agent reports during a conversation; it is **not a permanently running orchestrator**.
- A **local always-on service on the Owner's Omarchy laptop** is the execution orchestrator. No second agent-worker VPS is needed initially.
- Only **one active feature** at a time. Implementation, independent Review, independent QA and Lab Deployment/E2E iterate on the *same* feature until all gates are green or the task is BLOCKED.
- **One disposable, privately controlled VPS** hosts a synthetic PasarGuard instance and Fair Platform for realistic E2E testing; this is **not** a customer/production server and **not** the public HTTPS FP-003B staging installation.
- Agents may be granted admin rights on this explicitly disposable Lab VPS **only**. Production access, secret reuse and real-data imports are prohibited.
- Only the human Owner marks PRs Ready and merges. No speculative financial decisions, billing activation or direct writes to `development` or `main`.

## Documents

1. [Orchestration state machine and recursive fix loop](AGENT_ORCHESTRATION.md)
2. [Blank VPS SSH/host bootstrap and isolation](LAB_VPS_BOOTSTRAP.md)
3. [GitHub Issue/PR/evidence contract](GITHUB_TASK_AND_EVIDENCE.md)

## First activation sequence

1. Owner provisions a blank Ubuntu VPS with provider console/rescue access, **without** any production workloads or credentials.
2. Owner performs the **one-time verified SSH-key bootstrap** in `LAB_VPS_BOOTSTRAP.md`; never puts a password, private key, bot token, session secret or database credential in GitHub or chat.
3. An implementation task builds the laptop runner, GitHub issue polling and durable state machine as specified here, with an integration test that proves E2E failure → Implementation fix → independent rechecks → E2E re-run.
4. Separately provision synthetic PasarGuard, Fair Platform and test-only Telegram integration in the Lab; configure hard resource and token budgets.
5. Owner explicitly authorizes initial Lab activation after inspecting the host identity, access boundaries and workflow.
6. Only an approved task starts the queue. Passing tests proposes a merge; **the human Owner performs it**.

No automatic deployment, issue polling, SSH access or secret creation is enabled by this documentation PR.

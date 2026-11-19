# Fair Platform — Autonomous development lab

**Status (source-backed, 2026-11-19):** PR #55 merged; the supervised pilot and durable-queue/supervised-runner code and documentation now exist. **A repository snapshot cannot verify whether the Owner's laptop currently runs an unattended service, tmux session or queue.** Earlier "permanent service NOT activated" is historical, not a current runtime check. No separate disposable Lab VPS, production access or real PasarGuard/Telegram E2E is established by this repository. See [current status and agent security risks](../CURRENT_STATE_AND_POLICY_2026-11-19.md).

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
2. [Agent status and Caddy security](AGENT_STATUS_AND_CADDY_SECURITY.md)
3. [Durable GitHub task queue](DURABLE_QUEUE.md)
4. [GitHub Issue/PR/evidence contract](GITHUB_TASK_AND_EVIDENCE.md)
5. [Blank VPS SSH/host bootstrap and isolation](LAB_VPS_BOOTSTRAP.md)
6. [Codex model routing and usage budget](MODEL_ROUTING.md)
7. [Orchestrator implementation evidence](ORCHESTRATOR_IMPLEMENTATION.md)
8. [Supervised issue runner](SUPERVISED_ISSUE_RUNNER.md)

This README plus the eight linked guides are the nine files currently under
`docs/automation/`; runtime activation is not established by their existence.

## First activation sequence

1. Owner provisions a blank Ubuntu VPS with provider console/rescue access, **without** any production workloads or credentials.
2. Owner performs the **one-time verified SSH-key bootstrap** in `LAB_VPS_BOOTSTRAP.md`; never puts a password, private key, bot token, session secret or database credential in GitHub or chat.
3. The merged Orchestrator from PR #55 provides supervised local runner and durable state; PR #58 demonstrated Implementation → Review → QA for one approved task. Additional queue code now exists, but **continuous GitHub polling, `systemd --user` activation and real Lab-E2E cannot be inferred without inspecting the actual laptop runtime**. Run only in a separate unprivileged OS account/VM with no production credentials when unattended.
4. Separately provision synthetic PasarGuard, Fair Platform and test-only Telegram integration in the Lab; configure hard resource and token budgets.
5. Owner explicitly authorizes initial Lab activation after inspecting the host identity, access boundaries and workflow.
6. Only an approved task starts the queue. Passing tests proposes a merge; **the human Owner performs it**.

No automatic deployment, issue polling, SSH access or secret creation is enabled by this documentation PR.

# Fair Platform — historical autonomous development lab (cancelled)

**CURRENT OWNER DECISION (2026-11-19): CANCELLED / DO NOT RESTART.**
The Owner stopped using autonomous Implementation/Review/QA agents and does
not want the unattended queue/orchestrator activated. PR #55's pilot, queue
code, worktrees and documents remain as historical reference, **not active
release requirements**. A repository snapshot cannot remotely prove whether
individual laptop-local tmux/systemd processes were already stopped; no
process shutdown is performed by this documentation change. Current workflow:
[manual/CI review](../AGENT_WORKFLOW.md). Reactivation would require a **new
explicit Owner approval** plus proper OS isolation.

Tracking: [Issue #53](https://github.com/h-zare-dev/fair-platform/issues/53).

## Historical Owner decisions (superseded by cancellation)

- The **Owner + ChatGPT** define scope, architectural decisions and implementation-grade Markdown specifications. ChatGPT can create/read GitHub issues and inspect agent reports during a conversation; it is **not a permanently running orchestrator**.
- The former proposal called for a **local always-on service on the Owner's Omarchy laptop**. **Do not start it now**; the Owner has cancelled autonomous agent execution.
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

## Archived first activation proposal — NOT authorized

1. Owner provisions a blank Ubuntu VPS with provider console/rescue access, **without** any production workloads or credentials.
2. Owner performs the **one-time verified SSH-key bootstrap** in `LAB_VPS_BOOTSTRAP.md`; never puts a password, private key, bot token, session secret or database credential in GitHub or chat.
3. The merged Orchestrator from PR #55 provides supervised local runner and durable state; PR #58 demonstrated Implementation → Review → QA for one approved task. Additional queue code now exists, but **continuous GitHub polling, `systemd --user` activation and real Lab-E2E cannot be inferred without inspecting the actual laptop runtime**. Run only in a separate unprivileged OS account/VM with no production credentials when unattended.
4. Separately provision synthetic PasarGuard, Fair Platform and test-only Telegram integration in the Lab; configure hard resource and token budgets.
5. Owner explicitly authorizes initial Lab activation after inspecting the host identity, access boundaries and workflow.
6. Only an approved task starts the queue. Passing tests proposes a merge; **the human Owner performs it**.

**None of the steps above is authorized for execution under the current
cancelled-agent policy.** No automatic issue polling, agent deployment, SSH
access or secret creation is enabled by this documentation PR. Existing
**GitHub Actions staging deployment after human merge** is a different
release mechanism and remains unchanged.

# Codex model routing and usage budget — Fair Platform agent lab

> **ARCHIVED (Owner cancelled autonomous agents on 2026-11-19).** Configuration
> and command examples below document the former pilot. They are **not**
> instructions to reactivate agent services, and model routing is not a
> prerequisite for new feature PRs. See [automation status](README.md).

**Status:** The original pilot (task #57 / PR #55) used then-available Sol/Luna profiles. Those are **historical observations**, not a permanent model policy. Model availability and current private runtime configuration must be verified on the Owner's laptop; this repository does not prove unattended daemon activation or Lab E2E. Tracking #53 / PR #54.

| Responsibility | Model selection source | Reasoning effort | Note |
| --- | --- | --- | --- |
| Orchestrator AI fallback | private Owner routing config | Owner-selected | **Do not invoke a model for routine scheduling, polling, GitHub mutations, parsing, or command execution.** Deterministic TypeScript first. |
| Implementation | private Owner routing config | Owner-selected | Core coding, migrations and feature changes. |
| Independent Review | private Owner routing config | Owner-selected | Transaction/security/accounting correctness; independent verdict on exact commit. |
| QA / Tester | private Owner routing config | Owner-selected | Prefer deterministic Vitest/PostgreSQL/Playwright suites; use models for bounded diagnosis. |
| Deployment / Lab E2E | private Owner routing config | Owner-selected | Shell/SSH/Compose actions must be scripted, allowlisted and audited; use AI for diagnosis only. |
| Telegram / Historical Replay QA | private Owner routing config | Owner-selected | Test-only synthetic Telegram and offline replay; no private dataset in GitHub. |
| GitHub Reporting (AI only when needed) | private Owner routing config | Owner-selected | Prefer deterministic templates; never call an AI just to post status. |

A high-precision financial reasoning issue may request a different available model/effort **only by an explicit bounded Owner-approved escalation**. No automatic model upgrade or uncontrolled retry loops.

## Current supervised runtime security boundary

The PR #55 Codex gate was explicitly changed at the Owner's request to run all three coding/review/QA gates with `danger-full-access`. This removes the Codex filesystem sandbox **but does not isolate the agents at the OS level**: the worker can reach the Owner's user files, local credentials and network. Distinct Git worktrees prevent accidental cross-branch edits only; they do **not** enforce filesystem or network permissions. The commands below illustrate alternative manual TUI sessions, **not** the effective supervised Orchestrator sandbox setting.

Do not treat prompt instructions such as "no production" as a technical access restriction. Before unattended use, run under a separate, least-privileged OS account/container or equivalent environment with no production secrets, limited network, pinned tools and explicit allowlisted destinations. Continue to require Owner-only merge/deploy approvals and synthetic Lab-only access.

## CLI/TUI launcher requirements

The Owner previously used `~/.local/bin/fair-agents`, a `fair-platform` tmux session and separate implementation/review/QA worktrees; a separate `fair-replay-qa` launcher may also exist. **Preserve all** active sessions, window names, worktrees, uncommitted changes and histories. Do NOT replace scripts with guessed templates or kill existing tmux sessions. Back up local scripts first; inspect actual content and Codex CLI `--help`/version.

Suggested shape, if supported by installed Codex:

Configure the current model ID and effort per role in the Owner's **private**
`fair-agent-models.conf` (or equivalent validated runtime config), not in this
repository. If using a manual Codex TUI, read the configured values and run
`codex --help` first; never assume a historical model ID is still available.

For reporting, prefer **no model call**; if a model is actually needed, use the Owner-configured bounded effort. Validate model availability/effective reasoning using Codex `/model` and `/status`; launcher changes affect **new sessions**, not already running TUI sessions. Do not silently override a live session.

Prefer a single locally owned per-role config file consumed by both the manual `fair-agents` launcher and the future Orchestrator, rather than duplicate hardcoded model strings. The config should be editable without a source-code change and should expose model and reasoning effort separately.

## Plus usage protection

- One feature active at a time; only one model-heavy role at a time unless an exceptional scoped justification is approved.
- Deterministic orchestration and evidence generation; run test suites without models, then summarize once.
- Avoid repeatedly feeding whole repository, full old transcripts or private logs to a model; pass concise, bounded findings and exact file/line references.
- Cache task spec, test inventory and stable context; track model turn-count/usage metrics when available and **never invent** exact remaining 5h/weekly quota.
- Pause on account limits/authorization errors, save durable checkpoint; no auto-purchase, API billing fallback, credential substitution or repeated futile retries.
- Cap bug-fix cycles by the state-machine contract (default 3), with owner escalation when exhausted.
- Verify subscription access to the **configured** model IDs before activation; if unsupported, STOP/ask the Owner to select a supported fallback instead of silently changing model or thinking effort.

This file is a declarative contract: no actual launcher, session or systemd service has been changed by publishing it.

# Codex model routing and usage budget — Fair Platform agent lab

**Status:** Owner-selected configuration proposal (2026-11-14); to be implemented and verified on the Owner's Omarchy laptop. Tracking #53 / Draft PR #54.

| Responsibility | Preferred Codex model ID | Reasoning effort | Note |
| --- | --- | --- | --- |
| Orchestrator AI fallback | `gpt-6-luna` | `low` | **Do not invoke a model for routine scheduling, polling, GitHub mutations, parsing, or command execution.** Deterministic TypeScript first. |
| Implementation | `gpt-6-sol` | `low` | Core coding, migrations, feature changes. |
| Independent Review | `gpt-6-sol` | `low` | Transaction/security/accounting correctness. Escalate only exceptional complexity with owner-approved budget. |
| QA / Tester | `gpt-6-luna` | `low` | Use deterministic Vitest/PostgreSQL/Playwright suites; escalate complex financial debugging to Sol after bounded failure. |
| Deployment / Lab E2E | `gpt-6-luna` | `low` | Shell/SSH/Compose actions must be scripted, allowlisted and audited; use AI for diagnoses, not routine repeated execution. |
| Telegram / Historical Replay QA | `gpt-6-luna` | `low` | Test-only synthetic Telegram and offline replay verification; no private dataset in GitHub. |
| GitHub Reporting (AI only when needed) | `gpt-6-luna` | `none` | Prefer deterministic report templates; never call an AI just to post status. |

A high-precision financial reasoning issue may request `gpt-6-sol` at `medium` effort **only by an explicit bounded escalation**; the default stays low. No automatic switches to Astra/Pro/High or uncontrolled retry loops.

## CLI/TUI launcher requirements

The Owner already uses `~/.local/bin/fair-agents`, a `fair-platform` tmux session and the existing implementation/review/QA worktrees; a separate `fair-replay-qa` launcher may also exist. **Preserve all** active sessions, window names, worktrees, uncommitted changes and agent histories. Do NOT replace scripts with guessed templates or kill existing tmux sessions. Back up local scripts first; inspect actual content and Codex CLI `--help`/version.

Suggested shape, if supported by installed Codex:

```bash
mise exec -- codex -m gpt-6-sol -c 'model_reasoning_effort="low"' --sandbox workspace-write
mise exec -- codex -m gpt-6-sol -c 'model_reasoning_effort="low"' --sandbox read-only
mise exec -- codex -m gpt-6-luna -c 'model_reasoning_effort="low"' --sandbox workspace-write
```

A Luna reporting-only call can use `-c 'model_reasoning_effort="none"'`; by default reporting should not invoke Codex at all. Validate model availability and effective reasoning with Codex `/model` and `/status`, without launching expensive jobs. A launcher update affects **new sessions**, not already running interactive TUI sessions. Do not silently override a live session.

Prefer a single locally owned per-role config file consumed by both the manual `fair-agents` launcher and the future Orchestrator, rather than duplicate hardcoded model strings. The config should be editable without a source-code change and should expose model and reasoning effort separately.

## Plus usage protection

- One feature active at a time; only one model-heavy role at a time unless an exceptional scoped justification is approved.
- Deterministic orchestration and evidence generation; run test suites without models, then summarize once.
- Avoid repeatedly feeding whole repository, full old transcripts or private logs to a model; pass concise, bounded findings and exact file/line references.
- Cache task spec, test inventory and stable context; track model turn-count/usage metrics when available and **never invent** exact remaining 5h/weekly quota.
- Pause on account limits/authorization errors, save durable checkpoint; no auto-purchase, API billing fallback, credential substitution or repeated futile retries.
- Cap bug-fix cycles by the state-machine contract (default 3), with owner escalation when exhausted.
- Verify subscription access to these Codex model IDs before activation; if unsupported, STOP/ask the Owner to select a supported fallback instead of silently changing model or thinking effort.

This file is a declarative contract: no actual launcher, session or systemd service has been changed by publishing it.

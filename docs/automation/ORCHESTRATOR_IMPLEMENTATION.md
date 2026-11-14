# Issue #53 laptop orchestrator implementation status

This branch implements a **disabled, supervised Orchestrator prototype**. It is not an activated service, verified Lab, production deployment or human merge substitute. Issue #53 is the one-time bootstrap task and must not be submitted to the ordinary approved-feature queue. The example config deliberately has `issue: 0` and `labActivated: false`.

## Implemented

- The existing `fair-agents` and `fair-replay-qa` launchers read a shared local model config. Script backups were checked before editing. Existing tmux sessions and worktrees were not touched. New Codex processes use Sol Low for Implementation/Review and Luna Low for QA/Replay; these changes do not override running sessions.
- GitHub approval checks require a pinned spec blob, base SHA, label and Owner-authenticated exact-spec comment. The runner uses a private token file and passes the credential only to `gh` and Git publication, never to Codex gate processes.
- Implementation, independent Review and independent QA have actual `codex exec` adapters, separate dedicated worktrees, schema-bound verdicts, exact-head checks, timeouts and process resource limits. No model call was made during implementation or testing. Installed model availability is still unverified.
- A successful Implementation gate pushes only its dedicated feature branch, creates or updates a Draft PR and writes append-only SHA-bound issue/PR verdicts. GitHub `quality` checks are verified against the exact head. A candidate builder creates a two-parent merge candidate from the current development and feature head in a detached worktree, then runs install, typecheck and tests. These paths were tested with fakes; live authenticated GitHub publishing was not exercised here.
- The atomic checkpoint records in-flight commands and pending reports. A kernel `flock` releases after a killed process, and a restarted tick recovers locally recorded command evidence or blocks rather than blindly repeating an unknown side effect. Evidence comments are checked across pages before posting. Rework invalidates prior verdicts and reruns every gate. A daily model-call cap and per-process time/memory/file-descriptor limits are enforced.
- An Owner merge is accepted only when GitHub reports the expected PR/head, Owner `merged_by`, merge commit and current `development` SHA. Only then can post-merge verification run. The runner itself never merges or marks Ready.

## Remaining gates

- The Lab deploy, Lab E2E and post-merge gate executables in the example config are intentionally absent. No Lab host key, SSH identity, synthetic PasarGuard service, Telegram test bot or migration/rollback scenario has been configured or verified. `labActivated` is strictly false and the runner rejects any other value.
- Real end-to-end Codex agent, GitHub token, CI and candidate execution has not been performed; tests use fake Codex/pnpm commands and in-memory GitHub responses. Model availability, actual GitHub permissions, CI check payloads, PR publication and candidate resource sizing require supervised acceptance on a separately approved task.
- The service and timer are templates only and are not installed or enabled. The laptop must remain available; no claim of unattended operation or completed Lab E2E is made.

## Verification

The focused tests exercise approval rejection, Draft PR idempotency, stale CI and non-Owner merge rejection, credential isolation into a fake Codex executable, a real local two-parent Git candidate with fake test commands, strict config validation, lock contention, command/report interruption and restart, and a Lab E2E failure followed by the entire rework cycle. The Lab cycle is simulated and is **not** PasarGuard acceptance.

`pnpm typecheck`, focused Vitest, ESLint and Orchestrator TypeScript compilation passed locally. The full `pnpm build` stopped in the existing Next.js web build because Next.js reported a security vulnerability and refused to complete; this is an unresolved repository-wide build gate, not a passing build. The installed Next.js version needs a separately reviewed security update before a full green build can be claimed.

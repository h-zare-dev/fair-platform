# Issue #53 laptop orchestrator implementation status

The TypeScript state machine, atomic local checkpoint, GitHub approval guard, gate command interface and model routing are implemented in `scripts/orchestrator`. This is **not an activated service**. It does not deploy to a VPS, access production, merge a PR, or mark a PR Ready.

## Local configuration

`~/.local/bin/fair-agent-models.conf` is shared by the existing `fair-agents` and `fair-replay-qa` launchers and the runner. Copy the checked-in example before first use. The launcher change affects only newly started Codex processes and does not inspect or alter the active tmux socket. The installed CLI supports `-m` and `-c model_reasoning_effort=...` (observed `codex-cli 0.169.0`). Effective model availability is still unverified; do not start paid agent runs until it is checked interactively.

The runner config example uses non-existent `/opt/fair-agent-gates/*` executables intentionally. Each approved gate executable receives one JSON task object on stdin and returns a bounded JSON verdict on stdout. The executables must create or verify exact SHA evidence and keep private logs local. Independent Review and QA must use separate worktrees and histories. A service may be installed only after those executables, a private GitHub credential, process recovery, and Lab acceptance checks are complete.

Issue polling requires `agent:approved`, a pinned spec path/blob and base SHA, and a separate authenticated Owner comment `OWNER_APPROVED_SPEC: <path> @ <blob-sha>`. The issue label alone is insufficient. Current Issue #53 is an operator enablement issue and does not satisfy this feature-start protocol.

## Verification and limits

The simulated test exercises a Lab E2E failure, new Implementation SHA, independent Review and QA, CI, candidate, deploy and E2E re-run. Unit tests verify that a non-Owner comment cannot approve a task. No real GitHub mutation or Lab E2E was performed. `labActivated` defaults to false. `gh` is not authenticated in this execution environment, so live GitHub adapter calls cannot be locally exercised. Do not enable a scheduler or `systemd --user` service from this PR alone.

Remaining work before operation: real gate executables and Codex invocation, exact candidate build/CI verifier, PR creation/update, authenticated Owner merge detection, crash-safe lock recovery, usage quotas, Lab host pinning and synthetic scenario deployment, and full restart/chaos acceptance tests. Those gates remain separate from initial Lab activation approval.

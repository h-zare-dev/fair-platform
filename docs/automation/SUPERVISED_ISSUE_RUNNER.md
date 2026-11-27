# Supervised issue runner

Run one Owner-approved issue at a time from the checked-out repository. The issue must pin an exact spec blob, immutable spec commit, development base, and authenticated Owner approval. This is a supervised non-production pilot; it stops before CI, candidate, Lab, deployment, Ready, and merge. `LAST_PASS` is historical evidence, not proof of a live process.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p scripts/orchestrator/tsconfig.json
# One command after an exact Owner approval; prepares if needed, then runs in tmux.
node scripts/orchestrator/dist/supervised.js start <issue>

# Optional manual diagnostics:
node scripts/orchestrator/dist/supervised.js preflight <issue>
node scripts/orchestrator/dist/supervised.js prepare <issue>
node scripts/orchestrator/dist/supervised.js tmux <issue>
tmux attach -t fair-task-<issue>
```

Detach with `Ctrl-b d`. The `runner` window shows live progress; `status` shows the current runner PID and durable state, and `logs` follows the private runner log. `IN_FLIGHT_UNVERIFIED` describes saved state; it does not claim a model is still running. `tmux list-windows -t fair-task-<issue>` shows the windows. For a supervised foreground run or safe resume after an interrupted session with no pending launch reservation, use `node scripts/orchestrator/dist/supervised.js run <issue>`. The engine verifies an existing gate receipt and resumes publication without another model call. If no valid receipt exists, it records `UNRESOLVED_INFLIGHT` and stops. Never replay a potentially irreversible side effect. Stop with `Ctrl-C` in the runner pane. Laptop shutdown stops the process. The private global lock refuses a second task while one runs. The launcher never modifies the legacy `fair-agents` session or issue #57 pilot files.

At the Owner's explicit request, Codex runs in `danger-full-access` for Implementation, independent Review, and QA. This disables Codex filesystem/network sandbox isolation; model prompts and exact-SHA post-checks are not equivalent to host security boundaries. **Use only a dedicated, non-production user or isolated VM with no production keys, Pasarguard secrets, SSH credentials, finance/customer data or privileged server access.** This policy does not override SHA-bound approvals, global OS locks, protected-branch controls, immutable receipts or manual Owner merge. Review and QA remain logically independent and must not modify their worktrees; the runner verifies that after execution.

The supervisor advances Implementation, Review, and QA automatically and stops before CI. A quota refusal before a gate starts waits for the next UTC day. Any ambiguous gate or PR publication failure stops the runner; inspect the saved state and immutable receipt before restarting. `preflight`, `prepare`, `tmux`, and `run` all require the global OS lock, including direct invocation of the supervised task runner. Historical task identity and approved base SHA must remain pinned. The launcher does not commit the orchestrator source checkout; the Implementation gate may create task worktree commits as part of its approved run.

`start` and `tmux` hold the same global lock through tmux launch. They create a private `~/.local/state/fair-platform/supervised.launch` reservation before detaching. The reservation binds the issue to a random handoff token and tmux session. Every runner transition checks that reservation while holding the OS lock; only the runner in that session's `runner` pane with the matching token may advance. The reservation is removed only after that runner completes with no in-flight operation. A foreground `run`, interrupted runner, failed or partial tmux launch leaves the reservation in place and blocks further launches until an operator verifies the tmux session and task state. Direct runner calls using any supervised state, evidence, or worktree path also require the global lock, regardless of where the config file is copied. Do not delete the reservation solely to retry an unverified in-flight operation.

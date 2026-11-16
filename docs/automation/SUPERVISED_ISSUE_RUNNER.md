# Supervised issue runner

Run one Owner-approved issue at a time from the checked-out repository. The issue must pin an exact spec blob, immutable spec commit, development base, and authenticated Owner approval. This is a supervised non-production pilot; it stops before CI, candidate, Lab, deployment, Ready, and merge. `LAST_PASS` is historical evidence, not proof of a live process.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p scripts/orchestrator/tsconfig.json
node scripts/orchestrator/dist/supervised.js preflight <issue>
node scripts/orchestrator/dist/supervised.js prepare <issue>
node scripts/orchestrator/dist/supervised.js tmux <issue>
tmux attach -t fair-task-<issue>
```

Detach with `Ctrl-b d`. The `runner` window shows live progress; `status` shows the current runner PID and durable state, and `logs` follows the private runner log. `IN_FLIGHT_UNVERIFIED` describes saved state; it does not claim a model is still running. `tmux list-windows -t fair-task-<issue>` shows the windows. For a supervised foreground run or safe resume after an interrupted session, use `node scripts/orchestrator/dist/supervised.js run <issue>`. The engine verifies an existing gate receipt and resumes publication without another model call. If no valid receipt exists, it records `UNRESOLVED_INFLIGHT` and stops. Never replay a potentially irreversible side effect. Stop with `Ctrl-C` in the runner pane. Laptop shutdown stops the process. The private global lock refuses a second task while one runs. The launcher never modifies the legacy `fair-agents` session or issue #57 pilot files.

Codex `danger-full-access` is not OS-level isolation. Keep production credentials out of the ordinary user account; do not run an unattended daemon under that account.

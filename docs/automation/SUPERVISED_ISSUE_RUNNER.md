# Supervised issue runner

Run one Owner-approved issue at a time from the checked-out repository. The issue must pin an exact spec blob, immutable spec commit, development base, and authenticated Owner approval. This is a supervised non-production pilot; it stops before CI, candidate, Lab, deployment, Ready, and merge. `LAST_PASS` is historical evidence, not proof of a live process.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p scripts/orchestrator/tsconfig.json
node scripts/orchestrator/dist/supervised.js preflight 59
node scripts/orchestrator/dist/supervised.js prepare 59
node scripts/orchestrator/dist/supervised.js tmux 59
tmux attach -t fair-task-59
```

Detach with `Ctrl-b d`. The `runner` window shows live progress; `status` reads private state and `logs` follows private evidence logs. `tmux list-windows -t fair-task-59` shows the windows. For a supervised foreground run or safe resume, use `node scripts/orchestrator/dist/supervised.js run 59`. Stop with `Ctrl-C` in the runner pane. Check state and in-flight evidence before resuming. An unresolved in-flight gate must be reconciled manually; never replay a potentially irreversible side effect. Laptop shutdown stops the process. The private global lock refuses a second task while one runs. The launcher never modifies the legacy `fair-agents` session or issue #57 pilot files.

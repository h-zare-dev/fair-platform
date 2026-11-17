# Durable approved issue queue

The queue polls open approved GitHub issues, verifies each immutable spec and current development SHA, and delegates one issue to the supervised Implementation → Review → QA executor. That executor publishes a Draft PR and stops before CI promotion, candidate, Lab, deployment, Ready, or merge. The human Owner alone reviews and merges.

Run only under an isolated, unprivileged, non-production account or VM with no production tokens, SSH keys, customer or finance files, or privileged access. All three Codex gates use `danger-full-access`; it is not a host security boundary. Configure the existing supervised runner's GitHub token and model routing in that account first.

From the repository root, install and enable with `bash scripts/orchestrator/install-queue.sh enable`. Inspect with `node scripts/orchestrator/dist/queue.js status`. Stop with `systemctl --user stop fair-agent-queue.service`. The user service runs only while the account's user manager runs; laptop sleep, shutdown, and network loss pause progress. Enabling lingering is a separate Owner decision.

A saved in-flight gate or pending report can resume only when its exact task key and immutable receipt pass validation against the current worktree SHA. A missing or invalid receipt quarantines that issue. A stale launch reservation blocks automatic admission until an operator adjudicates the reserved runner and receipt. The Draft PR is published only after both independent Review and QA pass the same Implementation SHA. Historical PASS is never proof of a live model process. The queue's `queue.json` is only an observability cache; task state and immutable receipts remain authoritative.

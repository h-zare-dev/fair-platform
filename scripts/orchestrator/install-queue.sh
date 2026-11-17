#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -eq 1 && $1 == enable ]] || { echo 'Usage: install-queue.sh enable' >&2; exit 2; }
repo=$(git rev-parse --show-toplevel)
[[ "$PWD" == "$repo" ]] || { echo 'Run from repository root' >&2; exit 2; }
command -v systemctl >/dev/null
command -v flock >/dev/null
command -v node >/dev/null
pnpm exec tsc -p scripts/orchestrator/tsconfig.json
unit_dir="$HOME/.config/systemd/user"
state_dir="$HOME/.local/state/fair-platform"
mkdir -p -- "$unit_dir" "$state_dir"
chmod 700 -- "$unit_dir" "$state_dir"
node_bin=$(command -v node)
cat > "$unit_dir/fair-agent-queue.service" <<UNIT
[Unit]
Description=Fair Platform approved task queue
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$repo
ExecStart=/usr/bin/flock -n $state_dir/queue-worker.lock $node_bin $repo/scripts/orchestrator/dist/queue.js worker
Restart=on-failure
RestartSec=30
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now fair-agent-queue.service

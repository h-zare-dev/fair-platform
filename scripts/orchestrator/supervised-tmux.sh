#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -eq 4 && $1 =~ ^[1-9][0-9]*$ && $4 =~ ^[0-9a-f]{64}$ ]] || exit 2
issue=$1
cli=$2
state=$3
token=$4
session="fair-task-$issue"
if tmux has-session -t "=$session" 2>/dev/null; then
  echo 'Task tmux session already exists' >&2
  exit 1
fi
[[ -f "$HOME/.config/fair-platform/tasks/$issue.json" ]] || { echo 'Run prepare first' >&2; exit 1; }
qcli=$(printf '%q' "$cli")
log="$(dirname "$state")/runner.log"
mkdir -p -- "$(dirname "$log")"
chmod 700 -- "$(dirname "$log")"
: >> "$log"
chmod 600 -- "$log"
qlog=$(printf '%q' "$log")
qstate=$(printf '%q' "$state")
pid="$(dirname "$state")/runner.pid"
qpid=$(printf '%q' "$pid")
tmux new-session -d -s "$session" -n runner "trap 'rm -f -- $qpid' EXIT; echo \$\$ > $qpid; set -o pipefail; node $qcli run $issue $token 2>&1 | tee -a $qlog"
tmux new-window -d -t "=$session" -n status "watch -n 2 -- /bin/bash $(printf '%q' "$(dirname "$0")/supervised-status.sh") $qstate $qpid"
tmux new-window -d -t "=$session" -n logs "tail -n +1 -F $qlog"
printf 'Started %s; attach with tmux attach -t %s\n' "$session" "$session"

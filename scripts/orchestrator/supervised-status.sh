#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 2 ]] || exit 2
state=$1
pidfile=$2
if [[ -f $pidfile ]]; then
  pid=$(cat -- "$pidfile")
  if [[ $pid =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
    printf 'RUNNING PID=%s\n' "$pid"
  else
    printf 'STOPPED (stale PID record)\n'
  fi
else
  printf 'STOPPED\n'
fi
if [[ -f $state ]]; then
  python3 - "$state" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as file:
    state = json.load(file)
flight = state.get('inFlight')
print('PHASE=' + str(state.get('phase', 'UNKNOWN')))
print('HEAD=' + str(state.get('headSha') or '-'))
if flight:
    print('IN_FLIGHT_UNVERIFIED=' + str(flight.get('gate', 'UNKNOWN')))
else:
    print('IN_FLIGHT_UNVERIFIED=none')
PY
else
  printf 'STATE=not-started\n'
fi

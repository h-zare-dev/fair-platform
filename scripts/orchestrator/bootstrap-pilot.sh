#!/usr/bin/env bash
# Private, unprivileged setup for one Owner-approved, supervised pilot task.
# No token contents are printed. No daemon is started and no SSH is used.
set -Eeuo pipefail
umask 077

if [[ $# -ne 1 || ! "$1" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Usage: bash bootstrap-pilot.sh <approved-GitHub-issue-number>\n' >&2
  exit 2
fi
ISSUE="$1"
ROOT="$HOME/Work/fair-platform-status"
MODEL="$HOME/.local/bin/fair-agent-models.conf"
TOKEN="$HOME/.local/share/fair-platform/github-token"
CONFIG="$HOME/.config/fair-platform/pilot.json"
if [[ ! -f "$MODEL" || ! -f "$TOKEN" ]]; then
  echo "BLOCKED: model routes or private GitHub token are missing" >&2
  exit 2
fi
for name in node codex pnpm gh git python3; do
  command -v "$name" >/dev/null || { printf 'BLOCKED: %s missing\n' "$name" >&2; exit 2; }
done

# Do not overwrite an existing pilot or touch any previous task state.
if [[ -e "$CONFIG" ]]; then
  echo "BLOCKED: existing pilot config found; inspect it instead of overwriting" >&2
  exit 2
fi
if [[ ! -d "$ROOT/.git" && ! -f "$ROOT/.git" ]]; then
  echo "BLOCKED: expected status checkout is missing" >&2
  exit 2
fi

# Fetch refs needed for approved-base checkout; does not change a working tree.
git -C "$ROOT" fetch --quiet origin development

chmod 600 "$MODEL"
python3 - "$ISSUE" "$ROOT" "$MODEL" "$TOKEN" "$CONFIG" \
  "$(command -v node)" "$(command -v codex)" "$(command -v pnpm)" "$(command -v gh)" <<'PY'
import json
import os
from pathlib import Path
import sys

issue, root, model, token, dest, node, codex, pnpm, gh = sys.argv[1:]
home = Path.home()
p = Path(dest)
p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(p.parent, 0o700)
if p.exists():
    raise SystemExit("BLOCKED: config exists")

gate_js = Path(root) / "scripts/orchestrator/dist/gate.js"
if not gate_js.is_file():
    raise SystemExit("BLOCKED: compiled gate.js is missing; run pnpm build first")

def gate(role):
    return {"executable": node, "args": [str(gate_js), role], "timeoutMs": 3600000}

config = {
  "issue": int(issue),
  "ownerLogin": "h-zare-dev",
  "pilotMode": True,
  "labActivated": False,
  "stateFile": str(home / ".local/state/fair-platform/pilot-task.json"),
  "modelFile": model,
  "evidenceDir": str(home / ".local/state/fair-platform/pilot-evidence"),
  "maxModelCallsPerDay": 6,
  "worktrees": {
    "IMPLEMENTATION": str(home / "Work/fair-agent-implementation"),
    "REVIEW": str(home / "Work/fair-agent-review"),
    "QA": str(home / "Work/fair-agent-qa"),
  },
  "sourceRepo": root,
  "candidateWorktree": str(home / "Work/fair-agent-candidate"),
  "pnpmExecutable": pnpm,
  "codexExecutable": codex,
  "githubTokenFile": token,
  "ghExecutable": gh,
  "commands": {
    "IMPLEMENTATION": gate("IMPLEMENTATION"),
    "REVIEW": gate("REVIEW"),
    "QA": gate("QA"),
  }
}

fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print("PILOT_CONFIG_READY")
print("Config:", p)
print("Task:", issue)
print("Lab: disabled | production: disabled | merge: owner-only")
PY

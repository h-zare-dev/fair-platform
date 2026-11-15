#!/usr/bin/env bash
# Supervised continuation of the interrupted pilot #57, with no manual state edits.
# Archives attempt-2 source changes, starts a new attempt, stops before CI/Lab/merge.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CONFIG="$HOME/.config/fair-platform/pilot.json"
BRANCH="feature/issue-53-autonomous-orchestrator"

[[ -f "$CONFIG" ]] || {
  echo "BLOCKED: pilot configuration is missing" >&2
  exit 1
}
git -C "$ROOT" rev-parse --show-toplevel >/dev/null || {
  echo "BLOCKED: resolved path is not a Git checkout: $ROOT" >&2
  exit 1
}
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || {
  echo "BLOCKED: orchestrator source checkout has uncommitted changes" >&2
  exit 1
}
CURRENT="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE="$(git -C "$ROOT" ls-remote --exit-code origin "refs/heads/$BRANCH" | awk '{print $1}')"
[[ "$CURRENT" = "$REMOTE" ]] || {
  echo "BLOCKED: update the local orchestrator to the exact PR #55 SHA first" >&2
  exit 1
}

STATE_PATH="$(python3 - "$CONFIG" "$ROOT" <<'PY'
import json
from pathlib import Path
import sys

config_path = Path(sys.argv[1])
info = config_path.stat()
if info.st_mode & 0o077:
    raise SystemExit("BLOCKED: pilot config is not private")
cfg = json.loads(config_path.read_text())
root = Path(sys.argv[2]).resolve()
if not (
    cfg.get('issue') == 57
    and cfg.get('pilotMode') is True
    and cfg.get('labActivated') is False
    and cfg.get('ownerLogin') == 'h-zare-dev'
    and Path(cfg.get('sourceRepo', '')).resolve() == root
):
    raise SystemExit("BLOCKED: unexpected pilot configuration")
for gate in ('IMPLEMENTATION', 'REVIEW', 'QA'):
    cmd = cfg['commands'][gate]
    if cmd['args'] != [str(root / 'scripts/orchestrator/dist/gate.js'), gate]:
        raise SystemExit("BLOCKED: gate command changed")
print(cfg['stateFile'])
PY
)"

mkdir -p "$(dirname "$STATE_PATH")"
exec 9>"$STATE_PATH.driver.lock"
flock -n 9 || {
  echo "BLOCKED: another pilot driver is already running" >&2
  exit 1
}

cd "$ROOT"
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p scripts/orchestrator/tsconfig.json

python3 scripts/orchestrator/recover-pilot-git-sandbox.py "$CONFIG"
python3 scripts/orchestrator/recover-pilot-git-sandbox.py "$CONFIG" --execute

echo "========== IMPLEMENTATION -> REVIEW -> QA =========="
node scripts/orchestrator/dist/pilot.js "$CONFIG"

node - "$STATE_PATH" <<'JS'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const verdicts = state.verdicts ?? {};
const passed = ['IMPLEMENTATION', 'REVIEW', 'QA']
  .every((role) => verdicts[role]?.verdict === 'PASS');
const last = state.transitions.at(-1);
if (state.phase !== 'BLOCKED' ||
    last?.errorCode !== 'PILOT_END_BEFORE_CI' ||
    !passed ||
    !state.prNumber ||
    !state.headSha) {
  console.error(
    'PILOT_CHAIN_NOT_COMPLETE',
    'phase=' + state.phase,
    'error=' + (last?.errorCode ?? '-'),
  );
  process.exitCode = 1;
} else {
  console.log('PILOT_CHAIN_PASSED | issue=57 | draft-pr=' +
    state.prNumber + ' | head=' + state.headSha);
}
JS

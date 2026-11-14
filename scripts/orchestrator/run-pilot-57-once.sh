#!/usr/bin/env bash
# One supervised invocation, not an unattended daemon or production runner.
# On a verified PR #55 checkout this recovers the known #57 failure exactly once,
# then runs Implementation -> Review -> QA, stopping before CI/candidate/Lab/merge.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CONFIG="$HOME/.config/fair-platform/pilot.json"
TARGET="feature/issue-53-autonomous-orchestrator"

[[ -f "$CONFIG" ]] || { echo 'BLOCKED: private pilot config missing' >&2; exit 1; }
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || {
  echo 'BLOCKED: checkout is not clean' >&2
  exit 1
}
HEAD="$(git -C "$ROOT" rev-parse HEAD)"
REMOTE="$(git -C "$ROOT" ls-remote --exit-code origin "refs/heads/$TARGET" | awk '{print $1}')"
[[ "$HEAD" = "$REMOTE" ]] || {
  echo 'BLOCKED: local runner is not the published PR #55 head' >&2
  exit 1
}

STATE_PATH="$(python3 - "$CONFIG" "$ROOT" <<'PYCONF'
import json
import sys
from pathlib import Path

cfg = json.loads(Path(sys.argv[1]).read_text())
root = Path(sys.argv[2]).resolve()
assert cfg.get('issue') == 57
assert cfg.get('ownerLogin') == 'h-zare-dev'
assert cfg.get('pilotMode') is True and cfg.get('labActivated') is False
assert Path(cfg['sourceRepo']).resolve() == root
for role in ('IMPLEMENTATION', 'REVIEW', 'QA'):
    cmd = cfg['commands'][role]
    assert cmd['args'] == [str(root / 'scripts/orchestrator/dist/gate.js'), role]
print(cfg['stateFile'])
PYCONF
)"

mkdir -p "$(dirname "$STATE_PATH")"
exec 9>"$STATE_PATH.driver.lock"
flock -n 9 || { echo 'BLOCKED: another pilot driver is running' >&2; exit 1; }

cd "$ROOT"
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -p scripts/orchestrator/tsconfig.json

python3 scripts/orchestrator/recover-pilot-runtime.py "$CONFIG"
python3 scripts/orchestrator/recover-pilot-runtime.py "$CONFIG" --execute

node scripts/orchestrator/dist/pilot.js "$CONFIG"

node - "$STATE_PATH" <<'JSCHECK'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const last = state.transitions.at(-1);
const gates = ['IMPLEMENTATION', 'REVIEW', 'QA'];
const passed = gates.every((gate) => state.verdicts?.[gate]?.verdict === 'PASS');
if (state.phase !== 'BLOCKED' || last?.errorCode !== 'PILOT_END_BEFORE_CI' || !passed) {
  console.error('PILOT_NOT_PASSED:', state.phase, last?.errorCode ?? '-');
  process.exit(1);
}
console.log('PILOT_CHAIN_PASSED | implementation=PASS | review=PASS | qa=PASS | stop=BEFORE_CI');
JSCHECK

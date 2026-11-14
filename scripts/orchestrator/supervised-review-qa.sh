#!/usr/bin/env bash
# First supervised live agent acceptance for PR #55. It does not start the
# Orchestrator daemon, mutate GitHub, merge, deploy, or contact the Lab.
set -Eeuo pipefail
umask 077

readonly REPO="h-zare-dev/fair-platform"
readonly PR=55
readonly SOURCE="$HOME/Work/fair-platform-status"

for executable in gh git mise timeout tee mktemp; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'BLOCKED: missing executable: %s\n' "$executable" >&2
    exit 2
  fi
done

git -C "$SOURCE" rev-parse --is-inside-work-tree >/dev/null
PR_DRAFT="$(gh api "repos/$REPO/pulls/$PR" --jq '.draft')"
PR_BRANCH="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.ref')"
PR_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
if [[ "$PR_DRAFT" != true || "$PR_BRANCH" != feature/issue-53-autonomous-orchestrator ||
      ! "$PR_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "BLOCKED: Unexpected PR identity, state, or SHA" >&2
  exit 2
fi

git -C "$SOURCE" fetch --quiet origin "refs/pull/$PR/head"
FETCHED_SHA="$(git -C "$SOURCE" rev-parse FETCH_HEAD)"
if [[ "$PR_SHA" != "$FETCHED_SHA" ]]; then
  echo "BLOCKED: GitHub PR SHA does not match fetched code" >&2
  exit 2
fi

RUN_DIR="$(mktemp -d "$HOME/Work/fair-pr55-live-XXXXXXXX")"
printf '%s\n' "$RUN_DIR" > "$HOME/.fair-pr55-last-run"
printf 'PR=%s\nSHA=%s\nRUN_DIR=%s\n' "$PR" "$PR_SHA" "$RUN_DIR" > "$RUN_DIR/manifest.txt"
git -C "$SOURCE" worktree add --quiet --detach "$RUN_DIR/review" "$PR_SHA"
git -C "$SOURCE" worktree add --quiet --detach "$RUN_DIR/qa" "$PR_SHA"

status() {
  printf '%s\n' "$1" | tee "$RUN_DIR/status.txt"
}

printf '\nFair Platform real agent acceptance | PR #%s | SHA %s\n' "$PR" "$PR_SHA"
printf 'Evidence: %s\n' "$RUN_DIR"
printf 'No service, VPS, production access, GitHub mutation, or merge.\n\n'

REVIEW_PROMPT="Independently review Fair Platform Draft PR #55, at EXACT HEAD $PR_SHA. Read AGENTS.md. Your role is an independent security and architecture code reviewer, not an implementer. Focus on the newly built TypeScript Orchestrator: GitHub task approval and authentication, merge-check verification, credentials and command isolation, shell/exec handling, crash recovery, SHA-bound CI verification, and fail-closed behavior. Review code and existing tests in this checkout. Do not change files, create commits, push, merge, deploy, call production services or create subagents. The current GitHub security and containers gates are FAIL due to the unresolved upstream Caddy/go-jose/v3 advisory; do not report overall PR readiness. Return a concise report with VERDICT=PASS/FAIL/BLOCKED and independently substantiated findings (severity, file, line, reproduction or test gap). Do not print secrets."

QA_PROMPT="Act as independent Fair Platform QA on PR #55 at EXACT HEAD $PR_SHA. Read AGENTS.md. This is a real live Codex QA examination, but not a Lab deployment. Inspect the orchestrator code and tests and reason about failure-injection, idempotent reporting, stale SHA, approval authorization, crash recovery, plus usage budget, model routing, and whether the synthetic Lab rework loop matches the claimed contract. Do not modify code, commit, push, merge, run production commands, use subagents, or access the Lab. Security and containers CI remain FAIL on the upstream go-jose/v3 issue, so do not claim release readiness. Give a concise VERDICT=PASS/FAIL/BLOCKED with exact test gaps or reproducible defects. Do not print secrets."

status "REVIEW_RUNNING | $PR_SHA"
set +e
env -u GH_TOKEN -u GITHUB_TOKEN -u OPENAI_API_KEY \
  timeout --signal=TERM --kill-after=15s 30m \
  mise exec -- codex exec \
    -m gpt-6-sol \
    -c 'model_reasoning_effort="low"' \
    --sandbox read-only \
    -C "$RUN_DIR/review" \
    -o "$RUN_DIR/review-report.txt" \
    "$REVIEW_PROMPT" \
  2>&1 | tee "$RUN_DIR/review-terminal.log"
REVIEW_EXIT=$?
set -e
printf 'REVIEW_EXIT=%d\n' "$REVIEW_EXIT" >> "$RUN_DIR/manifest.txt"

status "QA_DETERMINISTIC_TESTS | $PR_SHA"
set +e
(
  cd "$RUN_DIR/qa" &&
  timeout --signal=TERM --kill-after=15s 10m mise exec -- pnpm install --frozen-lockfile &&
  timeout --signal=TERM --kill-after=15s 20m mise exec -- pnpm exec vitest run tests/orchestrator
) > "$RUN_DIR/qa-tests.log" 2>&1
QA_TEST_EXIT=$?
set -e
tail -n 16 "$RUN_DIR/qa-tests.log" || true
printf 'QA_TEST_EXIT=%d\n' "$QA_TEST_EXIT" >> "$RUN_DIR/manifest.txt"

QA_PROMPT="$QA_PROMPT The independent deterministic tests command returned exit status $QA_TEST_EXIT. An exit status other than zero is a blocking QA finding. Do not claim tests passed if this exit status is nonzero."
status "QA_AGENT_RUNNING | $PR_SHA"
set +e
env -u GH_TOKEN -u GITHUB_TOKEN -u OPENAI_API_KEY \
  timeout --signal=TERM --kill-after=15s 30m \
  mise exec -- codex exec \
    -m gpt-6-luna \
    -c 'model_reasoning_effort="low"' \
    --sandbox read-only \
    -C "$RUN_DIR/qa" \
    -o "$RUN_DIR/qa-report.txt" \
    "$QA_PROMPT" \
  2>&1 | tee "$RUN_DIR/qa-terminal.log"
QA_EXIT=$?
set -e
printf 'QA_AGENT_EXIT=%d\n' "$QA_EXIT" >> "$RUN_DIR/manifest.txt"

status "COMPLETE | REVIEW_EXIT=$REVIEW_EXIT QA_TEST_EXIT=$QA_TEST_EXIT QA_AGENT_EXIT=$QA_EXIT | NOT_RELEASE_READY"
printf '\n=== RUN SUMMARY ===\n'
cat "$RUN_DIR/manifest.txt"
printf '\nReview and QA reports are stored locally; this script never posts secrets or results to GitHub.\n'
printf 'Reports: %s/review-report.txt  %s/qa-report.txt\n' "$RUN_DIR" "$RUN_DIR"
if (( REVIEW_EXIT != 0 || QA_TEST_EXIT != 0 || QA_EXIT != 0 )); then
  exit 1
fi

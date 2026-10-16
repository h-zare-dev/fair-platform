#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${STAGING_ACTIVATION:-}" == 'owner-approved-v1' ]] || { printf 'STAGING_NOT_ACTIVATED\n'; exit 1; }
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$DEPLOY_USER" != root ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$DEPLOY_KEY" >"$work/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$work/known_hosts"
# Keep SSH diagnostics local to this ephemeral runner; emit only a fixed failure code.
ssh -T -p 22 -i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$work/known_hosts" -o ConnectTimeout=15 -o LogLevel=ERROR "$DEPLOY_USER@$DEPLOY_HOST" fair-staging-release <release.json 2>"$work/diagnostics" || {
  # Only fixed release codes may escape the restricted diagnostic file.
  for code in STAGING_NOT_ACTIVATED CONFIG_REQUIRES_OPERATOR_UPGRADE INITIAL_ACCEPTANCE_REQUIRED RESTORE_EVIDENCE_REQUIRED MIGRATION_COMPATIBILITY_UNPROVEN MIGRATION_FAILED_OPERATOR_REQUIRED APP_FAILED_PREVIOUS_RELEASE_RESTORED ROLLBACK_FAILED_OPERATOR_REQUIRED DEPLOYMENT_BUSY; do
    if grep -qx "$code" "$work/diagnostics"; then printf '%s\n' "$code"; fi
  done
  printf 'STAGING_DEPLOY_FAILED\n'; exit 1;
}

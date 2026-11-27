#!/usr/bin/env bash
# GitHub-hosted runner only. Reuse the pre-approved first-bootstrap trust anchor.
# No persistent private deployment key or new GitHub secret is required.
set -euo pipefail
umask 077
: "${STAGING_BOOTSTRAP_HOST:?}" "${STAGING_BOOTSTRAP_ROOT_PASSWORD:?}"
: "${STAGING_BOOTSTRAP_HOSTKEY_SHA256:?}" "${API:?}" "${WEB:?}" "${CADDY:?}" "${CONFIG_HASH:?}"
: "${GH_PACKAGES_READ_TOKEN:?}"
[[ "$GITHUB_REF" == refs/heads/development && "$GITHUB_EVENT_NAME" == push ]]
[[ "$GITHUB_REPOSITORY" == h-zare-dev/fair-platform ]]
[[ "$API" =~ ^ghcr\.io/h-zare-dev/fair-platform-owner-api@sha256:[0-9a-f]{64}$ ]]
[[ "$WEB" =~ ^ghcr\.io/h-zare-dev/fair-platform-web@sha256:[0-9a-f]{64}$ ]]
[[ "$CADDY" =~ ^ghcr\.io/h-zare-dev/fair-platform-caddy@sha256:[0-9a-f]{64}$ ]]
[[ "$CONFIG_HASH" =~ ^[0-9a-f]{64}$ ]]
[[ "$STAGING_BOOTSTRAP_HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
[[ "$STAGING_BOOTSTRAP_HOSTKEY_SHA256" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]
work=$(mktemp -d)
registry_logged_in=false
cleanup() {
  if [[ "$registry_logged_in" == true ]]; then
    sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
      'bash /opt/fair-staging/tooling/registry-temporary.sh logout' >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
python3 - "$STAGING_BOOTSTRAP_HOST" <<'PY'
import ipaddress,sys
address=ipaddress.ip_address(sys.argv[1]); assert address.version==4 and address.is_global
PY
ssh-keyscan -T 12 -p 22 -t ed25519 "$STAGING_BOOTSTRAP_HOST" >"$work/known_hosts" 2>/dev/null
actual=$(ssh-keygen -lf "$work/known_hosts" -E sha256 | awk '{print $2}')
[[ "$actual" == "$STAGING_BOOTSTRAP_HOSTKEY_SHA256" ]] || { echo 'PINNED_SSH_HOST_KEY_MISMATCH'; exit 1; }

ssh_opts=(-o StrictHostKeyChecking=yes -o BatchMode=no -o NumberOfPasswordPrompts=1
          -o PreferredAuthentications=password -o PubkeyAuthentication=no
          -o "UserKnownHostsFile=$work/known_hosts" -o ConnectTimeout=15 -o LogLevel=ERROR)
export SSHPASS="$STAGING_BOOTSTRAP_ROOT_PASSWORD"
unset STAGING_BOOTSTRAP_ROOT_PASSWORD
root_host="root@$STAGING_BOOTSTRAP_HOST"

# Query the ALREADY ACCEPTED DB image: never replace the PostgreSQL volume's
# current image merely because this merge built a new PostgreSQL helper image.
sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'python3 -c '\''import json;print(json.load(open("/opt/fair-staging/current.json"))["postgres"])'\''' \
  >"$work/postgres" 2>"$work/ssh-error" || { echo 'PINNED_STAGING_READ_FAILED'; exit 1; }
postgres=$(tr -d '\r\n' <"$work/postgres")
[[ "$postgres" =~ ^ghcr\.io/h-zare-dev/fair-platform-postgres@sha256:[0-9a-f]{64}$ ]] || {
  echo 'ACCEPTED_POSTGRES_IMAGE_INVALID'; exit 1;
}
python3 - "$work/release.json" "$postgres" <<'PY'
import json,os,sys
from pathlib import Path
release={'sha':os.environ['GITHUB_SHA'],'schema':'fp003b-v1','api':os.environ['API'],
         'web':os.environ['WEB'],'caddy':os.environ['CADDY'],
         'postgres':sys.argv[2],'configHash':os.environ['CONFIG_HASH']}
Path(sys.argv[1]).write_text(json.dumps(release))
PY
ssh-keygen -q -t ed25519 -N '' -f "$work/deploy-key" -C fair-staging-github-ephemeral
chmod 600 "$work/deploy-key"

# Install only reviewed, root-owned release tooling; never upload compose,
# runtime secrets, Owner credentials, or mutable application configuration.
sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'install -d -m 0755 -o root -g root /opt/fair-staging/tooling && chmod 0711 /opt/fair-staging && chmod 0755 /opt/fair-staging/tooling' \
  2>"$work/ssh-error" || { echo 'PINNED_STAGING_PREPARE_FAILED'; exit 1; }
files=(activate-local-test-vps.sh release.py ssh-release.sh fair-staging.sudoers
       health-monitor.sh health-monitor.service
       health-monitor.timer fair-staging-alert@.service alert.py registry-temporary.sh)
for name in "${files[@]}"; do
  [[ -f "scripts/staging/$name" ]]
done
sources=()
for name in "${files[@]}"; do sources+=("scripts/staging/$name"); done
sshpass -e scp -q "${ssh_opts[@]}" "${sources[@]}" \
  "$root_host:/opt/fair-staging/tooling/" 2>"$work/ssh-error" || {
    echo 'PINNED_STAGING_TOOLING_INSTALL_FAILED'; exit 1;
  }
sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'chown root:root /opt/fair-staging/tooling/* && chmod 700 /opt/fair-staging/tooling/activate-local-test-vps.sh /opt/fair-staging/tooling/registry-temporary.sh && chmod 755 /opt/fair-staging/tooling/ssh-release.sh /opt/fair-staging/tooling/release.py /opt/fair-staging/tooling/health-monitor.sh /opt/fair-staging/tooling/alert.py' \
  2>"$work/ssh-error" || { echo 'STAGING_TOOLING_PERMISSIONS_FAILED'; exit 1; }

# On each Owner-approved merge, safely disable the old daily Staging backup
# timer and transition the synthetic-only host to the explicit no-backup gate.
# The root password is used ONLY for installation and the transient key rotation.
sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'bash /opt/fair-staging/tooling/activate-local-test-vps.sh' \
  <"$work/deploy-key.pub" 2>"$work/ssh-error" || {
    echo 'STAGING_INITIAL_ACTIVATION_OR_KEY_ROTATION_FAILED'; exit 1;
  }

# The accepted PostgreSQL may predate this merge. GHCR might be private:
# provide only the current workflow's short-lived packages:read token in /run.
printf '%s' "$GH_PACKAGES_READ_TOKEN" | sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'bash /opt/fair-staging/tooling/registry-temporary.sh login' \
  2>"$work/ssh-error" || { echo 'STAGING_GHCR_TRANSIENT_AUTH_FAILED'; exit 1; }
unset GH_PACKAGES_READ_TOKEN
registry_logged_in=true
ssh -T -p 22 -i "$work/deploy-key" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known_hosts" \
  -o ConnectTimeout=15 -o LogLevel=ERROR \
  "fair-deploy@$STAGING_BOOTSTRAP_HOST" fair-staging-release \
  <"$work/release.json" 2>"$work/release-error" || {
    # These are fixed, secret-free release codes. Unknown diagnostics stay
    # redacted, but a failed guard should not be hidden behind a generic CI error.
    for code in STAGING_NOT_ACTIVATED STAGING_NO_BACKUP_POLICY_REQUIRED \
      CONFIG_REQUIRES_OPERATOR_UPGRADE MIGRATION_COMPATIBILITY_UNPROVEN \
      MIGRATION_FAILED_OPERATOR_REQUIRED APP_FAILED_PREVIOUS_RELEASE_RESTORED \
      APP_STARTUP_FAILED_PREVIOUS_RELEASE_RESTORED \
      APP_HEALTH_FAILED_PREVIOUS_RELEASE_RESTORED \
      APP_SMOKE_FAILED_PREVIOUS_RELEASE_RESTORED \
      APP_UNKNOWN_FAILED_PREVIOUS_RELEASE_RESTORED \
      DEPLOYMENT_BUSY UNRESOLVED_RELEASE_OPERATOR_REQUIRED RELEASE_SUPERSEDED \
      RELEASE_ORDER_UNVERIFIED RELEASE_NOT_DESCENDANT \
      POSTGRES_TRANSITION_UNAPPROVED ACCEPTED_DATABASE_DRIFT \
      IMAGE_PROVENANCE_MISMATCH PULL_FAILED_OPERATOR_REQUIRED \
      PREFLIGHT_FAILED_OPERATOR_REQUIRED DATABASE_CHANGED_DURING_PREFLIGHT \
      DATABASE_CHECK_FAILED_OPERATOR_REQUIRED \
      DATABASE_VOLUME_CHANGED_OPERATOR_REQUIRED \
      DATABASE_CHANGED_DURING_MIGRATION_OPERATOR_REQUIRED; do
      if grep -qx "$code" "$work/release-error"; then echo "$code"; fi
    done
    echo 'STAGING_DEPLOY_FAILED'; exit 1;
  }
sshpass -e ssh "${ssh_opts[@]}" "$root_host" \
  'bash /opt/fair-staging/tooling/registry-temporary.sh logout' \
  2>"$work/ssh-error" || { echo 'STAGING_GHCR_AUTH_CLEANUP_FAILED'; exit 1; }
registry_logged_in=false
printf 'STAGING_MERGE_DEPLOYMENT_COMPLETE %s\n' "$GITHUB_SHA"

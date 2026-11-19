#!/usr/bin/env bash
# One-time Owner-authorized installation for the already accepted SYNTHETIC VPS.
# Invoked through the existing pinned first-bootstrap credential; never by a PR.
set -euo pipefail
umask 077
root=/opt/fair-staging
settings=/etc/fair-staging
[[ $(id -u) == 0 ]]
[[ -f /etc/os-release ]]
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 26.04 ]]
[[ -f "$root/current.json" && -f "$root/current.env" ]]
[[ -f "$settings/activation.json" ]]
approval=$(python3 - "$settings/activation.json" <<'PY'
import json,sys
record=json.load(open(sys.argv[1]))
approval=record.get('approval','')
if approval == 'owner-approved-v1' and (record.get('schema')!='fp003b-v1' or record.get('backupPolicy') not in ('local-verified-v1','staging-no-backup-v1')):
    sys.exit('STAGING_BACKUP_POLICY_MISMATCH')
print(approval)
PY
)
[[ "$approval" == DISABLED || "$approval" == owner-approved-v1 ]] || { echo 'STAGING_ACTIVATION_INVALID'; exit 1; }

# Installation and policy transition must not race with a staging release.
exec 8>>"$root/deployment.lock"
flock -x -n 8 || { echo 'STAGING_DEPLOYMENT_BUSY'; exit 1; }

# The private key stays solely in the GitHub staging Environment. The public
# half is carried over the pinned one-time bootstrap SSH connection on stdin.
IFS= read -r deploy_key || true
[[ "$deploy_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9_.@-]+)?$ ]] || {
  echo 'INVALID_DEPLOY_PUBLIC_KEY'; exit 1;
}
keyfile=$(mktemp)
trap 'rm -f "$keyfile"' EXIT
printf '%s\n' "$deploy_key" >"$keyfile"
ssh-keygen -lf "$keyfile" -E sha256 | grep -q 'ED25519'

configure_deployer() {
  if ! id fair-deploy >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /home/fair-deploy --shell /bin/sh fair-deploy
  fi
  [[ $(id -u fair-deploy) -ne 0 ]]
  ! id -nG fair-deploy | tr ' ' '\n' | grep -qx docker
  install -d -m 0700 -o fair-deploy -g fair-deploy /home/fair-deploy/.ssh
  authfile=/home/fair-deploy/.ssh/authorized_keys
  temp_auth=$(mktemp -p /home/fair-deploy/.ssh .authorized-XXXXXXXX)
  printf 'restrict,command="/opt/fair-staging/tooling/ssh-release.sh" %s\n' "$deploy_key" >"$temp_auth"
  chown fair-deploy:fair-deploy "$temp_auth"
  chmod 600 "$temp_auth"
  mv -f -- "$temp_auth" "$authfile"
  install -m 0440 -o root -g root "$root/tooling/fair-staging.sudoers" /etc/sudoers.d/fair-staging-deploy
  visudo -cf /etc/sudoers.d/fair-staging-deploy >/dev/null
  chmod 0755 "$root/tooling/release.py" "$root/tooling/ssh-release.sh"
}

disable_local_backup() {
  # Owner explicitly no longer requests even the same-host backup timer.
  # Do not interrupt an in-flight backup service or remove any saved archives.
  if systemctl list-unit-files --no-legend --no-pager fair-staging-backup.timer 2>/dev/null \
      | grep -q '^fair-staging-backup\.timer[[:space:]]'; then
    systemctl disable --now fair-staging-backup.timer >/dev/null
  fi
  if systemctl is-active --quiet fair-staging-backup.timer || \
      systemctl is-active --quiet fair-staging-backup.service; then
    echo 'STAGING_BACKUP_STILL_ACTIVE' >&2
    exit 1
  fi
}

approve_no_backup_policy() {
  python3 - "$settings/activation.json" <<'PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
assert not path.is_symlink()
data = json.loads(path.read_text())
assert data['approval'] == 'owner-approved-v1' and data['schema'] == 'fp003b-v1'
assert data['backupPolicy'] in ('local-verified-v1', 'staging-no-backup-v1')
data['backupPolicy'] = 'staging-no-backup-v1'
fd, tmp = tempfile.mkstemp(prefix='.activation-no-backup-', dir=path.parent)
try:
    with os.fdopen(fd, 'w') as file:
        json.dump(data, file, sort_keys=True)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
}

if [[ "$approval" == owner-approved-v1 ]]; then
  configure_deployer
  disable_local_backup
  approve_no_backup_policy
  printf 'LOCAL_STAGING_DEPLOY_KEY_ROTATED_NO_BACKUP\n'
  exit 0
fi

python3 - "$root" <<'PY'
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'tooling'))
from release import config_hash,manifest
root=Path(sys.argv[1]); accepted=manifest(json.loads((root/'current.json').read_text()))
assert accepted['configHash']==config_hash(root), 'CURRENT_CONFIG_DRIFT'
expected={
  'API_IMAGE':accepted['api'], 'WEB_IMAGE':accepted['web'],
  'CADDY_IMAGE':accepted['caddy'], 'POSTGRES_IMAGE':accepted['postgres'],
}
existing=dict(line.split('=',1) for line in (root/'current.env').read_text().splitlines())
assert all(existing.get(k)==v for k,v in expected.items()), 'ACCEPTED_IMAGE_ENV_DRIFT'
assert existing.get('SECRETS_DIR')=='/etc/fair-staging/secrets'
assert existing.get('ACME_EMAIL')
PY

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends sudo

# Explicit approval of the currently running accepted baseline only. Future
# new/changed migration hashes still fail closed in release.py.
cd "$root"
compat_tmp=$(mktemp -p "$settings" .compatibility-XXXXXX)
docker compose --env-file current.env -f compose.yml run --rm --no-deps -T \
  migrate node dist/owner/release-check.js 2>/dev/null \
  | python3 -c 'import json,sys; o=json.load(sys.stdin); assert o["schema"]=="fp003b-v1"; assert len(o["configuredMigrations"])==3; assert len(o["hashes"])==3; print(json.dumps({"configuredMigrations":o["configuredMigrations"],"hashes":o["hashes"]}))' >"$compat_tmp"
chmod 600 "$compat_tmp"
mv -f -- "$compat_tmp" "$settings/compatible-migrations.json"

configure_deployer
disable_local_backup
install -m 0644 -o root -g root "$root/tooling/health-monitor.timer" /etc/systemd/system/fair-staging-health-monitor.timer
install -m 0644 -o root -g root "$root/tooling/health-monitor.service" /etc/systemd/system/fair-staging-health-monitor.service
install -m 0644 -o root -g root "$root/tooling/fair-staging-alert@.service" /etc/systemd/system/fair-staging-alert@.service
chmod 0755 "$root/tooling/health-monitor.sh" "$root/tooling/alert.py"
systemctl daemon-reload
systemctl enable --now fair-staging-health-monitor.timer >/dev/null

# Flip host gate only after all non-backup prerequisites have succeeded.
python3 - "$root" "$settings" <<'PY'
import json,os,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1]); settings=Path(sys.argv[2])
env=dict(line.split('=',1) for line in (root/'current.env').read_text().splitlines())
data={'approval':'owner-approved-v1','schema':'fp003b-v1','acmeEmail':env['ACME_EMAIL'],
      'secretsDir':env['SECRETS_DIR'],'backupPolicy':'staging-no-backup-v1'}
fd,tmp=tempfile.mkstemp(dir=settings)
with os.fdopen(fd,'w') as file:
    json.dump(data,file)
    file.flush()
    os.fsync(file.fileno())
os.replace(tmp,settings/'activation.json')
os.chmod(settings/'activation.json',0o600)
PY
printf 'LOCAL_STAGING_HOST_ACTIVATED_NO_BACKUP\n'

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
if approval == 'owner-approved-v1' and (record.get('schema')!='fp003b-v1' or record.get('backupPolicy')!='local-verified-v1'):
    sys.exit('STAGING_BACKUP_POLICY_MISMATCH')
print(approval)
PY
)
[[ "$approval" == DISABLED || "$approval" == owner-approved-v1 ]] || { echo 'STAGING_ACTIVATION_INVALID'; exit 1; }

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

if [[ "$approval" == owner-approved-v1 ]]; then
  configure_deployer
  printf 'LOCAL_STAGING_DEPLOY_KEY_ROTATED\n'
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
apt-get install -y -qq --no-install-recommends age sudo
install -d -m 0700 -o root -g root "$settings" /var/backups/fair-staging
key="$settings/local-backup-identity"
if [[ ! -e "$key" ]]; then
  age-keygen -o "$key" >/dev/null 2>&1
fi
[[ -f "$key" && ! -L "$key" ]]
chmod 600 "$key"
recipient=$(age-keygen -y "$key")
[[ "$recipient" =~ ^age1[a-z0-9]{20,}$ ]]

backup_tmp=$(mktemp -p "$settings" .backup-env-XXXXXX)
printf 'STAGING_ROOT=/opt/fair-staging\nBACKUP_POLICY=local-verified-v1\nBACKUP_LOCAL_DIR=/var/backups/fair-staging\nBACKUP_RECIPIENT=%s\nBACKUP_IDENTITY_FILE=%s\nRESTORE_EVIDENCE_FILE=/etc/fair-staging/restore-verified.json\nBACKUP_RETENTION_DAYS=7\n' "$recipient" "$key" >"$backup_tmp"
chmod 600 "$backup_tmp"
mv -f -- "$backup_tmp" "$settings/backup.env"

# Explicit approval of the currently running accepted baseline only. Future
# new/changed migration hashes still fail closed in release.py.
cd "$root"
compat_tmp=$(mktemp -p "$settings" .compatibility-XXXXXX)
docker compose --env-file current.env -f compose.yml run --rm --no-deps -T \
  migrate node dist/owner/release-check.js 2>/dev/null \
  | python3 -c 'import json,sys; o=json.load(sys.stdin); assert o["schema"]=="fp003b-v1"; assert len(o["configuredMigrations"])==3; assert len(o["hashes"])==3; print(json.dumps({"configuredMigrations":o["configuredMigrations"],"hashes":o["hashes"]}))' >"$compat_tmp"
chmod 600 "$compat_tmp"
mv -f -- "$compat_tmp" "$settings/compatible-migrations.json"

# Backup/restore both happen on this SAME VPS. Losing its disk loses backups.
"$root/tooling/backup-with-settings.sh"
python3 - "$settings/restore-verified.json" <<'PY'
import datetime,json,sys
record=json.load(open(sys.argv[1]))
assert record['backupPolicy']=='local-verified-v1'
at=datetime.datetime.fromisoformat(record['verifiedAt'])
assert at.tzinfo and (datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<600
PY

configure_deployer
install -m 0644 -o root -g root "$root/tooling/backup.timer" /etc/systemd/system/fair-staging-backup.timer
install -m 0644 -o root -g root "$root/tooling/backup.service" /etc/systemd/system/fair-staging-backup.service
install -m 0644 -o root -g root "$root/tooling/health-monitor.timer" /etc/systemd/system/fair-staging-health-monitor.timer
install -m 0644 -o root -g root "$root/tooling/health-monitor.service" /etc/systemd/system/fair-staging-health-monitor.service
install -m 0644 -o root -g root "$root/tooling/fair-staging-alert@.service" /etc/systemd/system/fair-staging-alert@.service
chmod 0755 "$root/tooling/health-monitor.sh" "$root/tooling/alert.py"
systemctl daemon-reload
systemctl enable --now fair-staging-backup.timer >/dev/null
systemctl enable --now fair-staging-health-monitor.timer >/dev/null

# Flip host gate only after all prerequisites and isolated recovery succeeded.
python3 - "$root" "$settings" <<'PY'
import json,os,sys,tempfile
from pathlib import Path
root=Path(sys.argv[1]); settings=Path(sys.argv[2])
env=dict(line.split('=',1) for line in (root/'current.env').read_text().splitlines())
data={'approval':'owner-approved-v1','schema':'fp003b-v1','acmeEmail':env['ACME_EMAIL'],
      'secretsDir':env['SECRETS_DIR'],'backupPolicy':'local-verified-v1'}
fd,tmp=tempfile.mkstemp(dir=settings)
with os.fdopen(fd,'w') as file:
    json.dump(data,file)
    file.flush()
    os.fsync(file.fileno())
os.replace(tmp,settings/'activation.json')
os.chmod(settings/'activation.json',0o600)
PY
printf 'LOCAL_STAGING_HOST_ACTIVATED\n'

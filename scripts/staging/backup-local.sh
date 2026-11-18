#!/usr/bin/env bash
# Owner-approved SYNTHETIC staging exception: encrypted backup on this VPS only.
# Disk/VPS loss destroys this backup too; never use for production finance.
set -euo pipefail
umask 077
: "${STAGING_ROOT:?}" "${BACKUP_LOCAL_DIR:?}" "${BACKUP_RECIPIENT:?}"
: "${BACKUP_IDENTITY_FILE:?}" "${RESTORE_EVIDENCE_FILE:?}" "${BACKUP_RETENTION_DAYS:?}"
[[ "$STAGING_ROOT" == /opt/fair-staging ]]
[[ "$BACKUP_LOCAL_DIR" == /var/backups/fair-staging ]]
[[ "$RESTORE_EVIDENCE_FILE" == /etc/fair-staging/restore-verified.json ]]
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( BACKUP_RETENTION_DAYS >= 7 ))
[[ "$BACKUP_RECIPIENT" =~ ^age1[a-z0-9]{20,}$ ]]
[[ -f "$BACKUP_IDENTITY_FILE" && ! -L "$BACKUP_IDENTITY_FILE" ]]
[[ $(stat -c %a "$BACKUP_IDENTITY_FILE") == 600 ]]
[[ $(id -u) == 0 ]]

install -d -m 0700 -o root -g root "$BACKUP_LOCAL_DIR"
[[ ! -L "$BACKUP_LOCAL_DIR" ]]
[[ $(stat -c %a "$BACKUP_LOCAL_DIR") == 700 ]]
exec 9>"$BACKUP_LOCAL_DIR/.backup.lock"
flock -x 9

# Keep a failure from consuming the disk while a dump is still being produced.
free_bytes=$(df -PB1 --output=avail "$BACKUP_LOCAL_DIR" | tail -n 1 | tr -d ' ')
[[ "$free_bytes" =~ ^[0-9]+$ ]] && (( free_bytes >= 2147483648 )) || {
  printf 'LOCAL_BACKUP_SPACE_INSUFFICIENT\n' >&2
  exit 1
}

now=$(date -u +%Y%m%dT%H%M%SZ)
name="fair-staging-${now}.dump.age"
work=$(mktemp -d -p "$BACKUP_LOCAL_DIR" .pending-XXXXXXXX)
cleanup() {
  status=$?
  if (( status != 0 )); then
    docker rm -f fair-staging-backup >/dev/null 2>&1 || true
    printf 'LOCAL_BACKUP_FAILED\n' >&2
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

cd "$STAGING_ROOT"
docker compose --env-file current.env -f compose.yml run --rm --no-deps \
  --name fair-staging-backup -T backup 2>"$work/diagnostics" \
  | (ulimit -f 1048576; age -r "$BACKUP_RECIPIENT") \
  >"$work/$name" 2>>"$work/diagnostics"
[[ -s "$work/$name" ]]
sync -f "$work/$name"
[[ ! -e "$BACKUP_LOCAL_DIR/$name" ]] || { printf 'LOCAL_BACKUP_NAME_COLLISION\n' >&2; exit 1; }
mv -n -- "$work/$name" "$BACKUP_LOCAL_DIR/$name"
[[ ! -e "$work/$name" ]]
[[ -s "$BACKUP_LOCAL_DIR/$name" ]]

# Recovery proof uses a disposable, networkless PostgreSQL container and tmpfs.
export BACKUP_LOCATION=local
export BACKUP_OBJECT="$BACKUP_LOCAL_DIR/$name"
export RESTORE_POSTGRES_IMAGE
RESTORE_POSTGRES_IMAGE=$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path('/opt/fair-staging/current.json').read_text())['postgres'])
PY
)
export RESTORE_EVIDENCE_FILE
/opt/fair-staging/tooling/restore-verify.sh >"$work/restore-out" 2>>"$work/diagnostics"
grep -qx 'ISOLATED_RESTORE_OK' "$work/restore-out"

# Never remove backup objects before a verified replacement exists.
find -P "$BACKUP_LOCAL_DIR" -maxdepth 1 -type f \
  -name 'fair-staging-*.dump.age' -mtime "+$BACKUP_RETENTION_DAYS" -delete
printf 'LOCAL_ENCRYPTED_BACKUP_AND_RESTORE_OK\n'

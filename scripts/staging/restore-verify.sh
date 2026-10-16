#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RESTORE_POSTGRES_IMAGE:?}" "${BACKUP_OBJECT:?}" "${RCLONE_CONFIG:?}" "${BACKUP_IDENTITY_FILE:?}"
[[ "$RESTORE_POSTGRES_IMAGE" =~ ^(ghcr\.io/h-zare-dev/fair-platform-postgres@)?sha256:[a-f0-9]{64}$ ]]
[[ -f "$RCLONE_CONFIG" && $(stat -c %a "$RCLONE_CONFIG") == 600 ]]
[[ -f "$BACKUP_IDENTITY_FILE" && $(stat -c %a "$BACKUP_IDENTITY_FILE") == 600 ]]
work=$(mktemp -d)
container="fair-restore-verify-$(date +%s)-$$"
cleanup() { status=$?; if ((status != 0)); then printf 'ISOLATED_RESTORE_FAILED\n'; fi; docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
rclone --contimeout 15s --timeout 60s --retries 3 --low-level-retries 3 --config "$RCLONE_CONFIG" copyto "$BACKUP_OBJECT" "$work/backup.age" --quiet 2>"$work/diagnostics"
docker run -d --name "$container" --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust "$RESTORE_POSTGRES_IMAGE" > /dev/null
ready=false
# The entrypoint's temporary initialization server listens only on a UNIX socket.
# Loopback TCP plus an actual SQL query accepts only the final initialized server.
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -t 1 >/dev/null 2>&1 &&
    docker exec -e PGCONNECT_TIMEOUT=1 -e 'PGOPTIONS=-c statement_timeout=1000' "$container" psql -h 127.0.0.1 -U postgres -d postgres -w -v ON_ERROR_STOP=1 -Atc 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]]
age -d -i "$BACKUP_IDENTITY_FILE" "$work/backup.age" 2>>"$work/diagnostics" | docker exec -i "$container" pg_restore -h 127.0.0.1 -U postgres -w -d postgres --exit-on-error --no-owner --no-acl 2>>"$work/diagnostics"
docker exec "$container" psql -h 127.0.0.1 -U postgres -d postgres -w -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM fair_owner; SELECT count(*) FROM pasarguard_events; SELECT count(*) FROM pasarguard_ingestion_issues' >"$work/counts" 2>>"$work/diagnostics"
mapfile -t counts <"$work/counts"
[[ "${counts[0]:-}" == 1 && "${counts[1]:-}" =~ ^[0-9]+$ && "${counts[2]:-}" =~ ^[0-9]+$ ]]
if [[ -n "${RESTORE_EVIDENCE_FILE:-}" ]]; then
  python3 - <<'PYEVIDENCE'
import datetime, json, os, tempfile
from pathlib import Path
path=Path(os.environ['RESTORE_EVIDENCE_FILE'])
fd,name=tempfile.mkstemp(dir=path.parent)
with os.fdopen(fd,'w') as handle:
    json.dump({'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()},handle)
os.replace(name,path)
PYEVIDENCE
fi
printf 'ISOLATED_RESTORE_OK\n'

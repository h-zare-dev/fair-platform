#!/usr/bin/env bash
set -euo pipefail
umask 077
# Operator-installed tools; no secret values in command arguments or log output.
: "${STAGING_ROOT:?}" "${BACKUP_RECIPIENT:?}" "${BACKUP_REMOTE:?}" "${RCLONE_CONFIG:?}" "${BACKUP_RETENTION_DAYS:?}"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && (( BACKUP_RETENTION_DAYS >= 7 ))
[[ "$BACKUP_REMOTE" == *:* && "$BACKUP_REMOTE" != *".."* && "$BACKUP_REMOTE" != *" "* ]]
[[ -f "$RCLONE_CONFIG" && $(stat -c %a "$RCLONE_CONFIG") == 600 ]]
cd "$STAGING_ROOT"
work=$(mktemp -d)
cleanup() { status=$?; rm -rf "$work"; if ((status != 0)); then printf 'BACKUP_FAILED\n'; fi; }
trap cleanup EXIT
name="fair-staging-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
# pipefail ensures a failed dump/encryption is never uploaded as a valid backup.
docker compose --env-file current.env -f compose.yml run --rm -T backup 2>"$work/diagnostics" | age -r "$BACKUP_RECIPIENT" >"$work/$name" 2>>"$work/diagnostics"
rclone --contimeout 15s --timeout 60s --retries 3 --low-level-retries 3 --config "$RCLONE_CONFIG" copyto "$work/$name" "$BACKUP_REMOTE/$name" --quiet 2>>"$work/diagnostics"
# Retention touches only this dedicated prefix and only after successful upload.
rclone --contimeout 15s --timeout 60s --retries 3 --low-level-retries 3 --config "$RCLONE_CONFIG" delete "$BACKUP_REMOTE" --include 'fair-staging-*.dump.age' --min-age "${BACKUP_RETENTION_DAYS}d" --quiet 2>>"$work/diagnostics"
printf 'BACKUP_OK\n'

#!/usr/bin/env bash
# Output-only backup. No pruning, restore, volume change or silent off-host claim.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo PRODUCTION_ROOT_ONLY >&2; exit 1; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
settings=/etc/fair-production
[[ -f "$settings/installed" ]] || { echo PRODUCTION_NOT_INSTALLED >&2; exit 1; }
python3 "$repo/scripts/production/preflight.py" "$settings/release.env" >/dev/null
destination=/var/backups/fair-production
install -d -m 0700 -o root -g root "$destination"
exec 8>"$destination/.backup.lock"
flock -n 8 || { echo PRODUCTION_BACKUP_BUSY >&2; exit 1; }
output="$destination/fair-$(date -u +%Y%m%dT%H%M%SZ).dump"
[[ ! -e "$output" ]] || { echo PRODUCTION_BACKUP_ALREADY_EXISTS >&2; exit 1; }
temp=$(mktemp "$destination/.incomplete.XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
compose=(docker compose --env-file "$settings/release.env" -f "$repo/docker/production/compose.yml")
"${compose[@]}" run --rm --no-deps -T backup >"$temp"
[[ -s "$temp" ]] || { echo PRODUCTION_BACKUP_EMPTY >&2; exit 1; }
"${compose[@]}" run --rm --no-deps -T backup pg_restore --list <"$temp" >/dev/null
chmod 0600 "$temp"
mv -n -- "$temp" "$output"
printf 'PRODUCTION_LOCAL_BACKUP_CREATED %s\n' "$output"
# An operator must separately verify encrypted off-host backup and restore.

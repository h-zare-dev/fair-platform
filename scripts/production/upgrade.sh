#!/usr/bin/env bash
# Owner-supervised app-only release update. Existing database/volumes are never removed.
set -euo pipefail
umask 077

die() { printf 'PRODUCTION_UPGRADE_ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 && $# == 2 ]] || die 'USAGE_ROOT: upgrade.sh NEW_SPARSE_BUNDLE ACTIVE_BUNDLE'
[[ -t 0 && -t 1 ]] || die 'A private interactive terminal is required.'
candidate=$(realpath -e -- "$1")
previous=$(realpath -e -- "$2")
[[ "$candidate" != "$previous" ]] || die 'Candidate is already active.'
[[ -f "$candidate/docker/production/compose.yml" && -f "$candidate/scripts/production/site-config.py" ]] || die 'Candidate bundle incomplete.'
[[ -f "$previous/docker/production/compose.yml" && -f "$previous/scripts/production/backup.sh" ]] || die 'Active bundle incomplete.'
settings=/etc/fair-production
release="$settings/release.env"
site="$settings/site.env"
[[ -f "$settings/installed" && ! -L "$settings" && ! -L "$release" ]] || die 'Unknown or symlinked production installation.'
[[ $(stat -c %u "$release") == 0 && $(stat -c %a "$release") == 600 ]] || die 'Unsafe release permissions.'
python3 "$candidate/scripts/production/preflight.py" "$release" >/dev/null
exec 8>"$settings/setup.lock"
flock -n 8 || die 'Another production operation is running.'
old_sha=$(sed -n 's/^RELEASE_SHA=//p' "$release")
new_sha=$(cat "$candidate/REVISION")
[[ "$old_sha" =~ ^[0-9a-f]{40}$ && "$new_sha" =~ ^[0-9a-f]{40}$ ]] || die 'Invalid release commit.'
[[ "$old_sha" != "$new_sha" ]] || { printf 'PRODUCTION_ALREADY_UP_TO_DATE %s\n' "$old_sha"; exit 0; }

# A generic no-data-loss update cannot safely roll back an unknown SQL migration.
# Require a separate reviewed migration procedure if schema/grants/PostgreSQL change.
legacy_close=$(python3 "$candidate/scripts/production/bundle-check.py" "$candidate" "$previous" "$old_sha") || die 'SCHEMA_OR_POSTGRES_CHANGED or active bundle cannot be verified.'
shadow=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' fair-production-owner-api-1 | sed -n 's/^FAIR_SHADOW_ENABLED=//p')
case "$shadow" in
  true)
    [[ -f "$settings/directory.env" ]] || die 'Active SHADOW directory settings missing.'
    read -r -p 'Preserve enabled SHADOW accounting during this update? [y/N]: ' approval
    [[ "$approval" == [yY] || "$approval" == [yY][eE][sS] ]] || die 'Operator declined.'
    ;;
  false) ;;
  *) die 'Cannot determine the running SHADOW mode.' ;;
esac
expected_id=$(docker image inspect --format '{{.Id}}' "$(sed -n 's/^API_IMAGE=//p' "$release")") || die 'Pinned old API image is missing.'
running_id=$(docker inspect --format '{{.Image}}' fair-production-owner-api-1) || die 'Owner API is missing.'
[[ "$expected_id" == "$running_id" ]] || die 'Running API differs from the pinned release.'
docker volume inspect fair-production_postgres_data >/dev/null || die 'Database volume missing.'

if [[ -f "$site" ]]; then
  [[ ! -L "$site" && $(stat -c %u "$site") == 0 && $(stat -c %a "$site") == 600 ]] || die 'Unsafe site.env.'
  host=$(python3 "$candidate/scripts/production/site-config.py" read "$site") || die 'Invalid site.env.'
else
  read -r -p 'Panel hostname, IPv4 or localhost (e.g. panel.example.com): ' host
  python3 "$candidate/scripts/production/site-config.py" host "$host" >/dev/null || die 'Invalid hostname/IP.'
fi
printf '\nInstalled: %s\nPublished candidate: %s\nOwner UI: https://%s\n' "$old_sha" "$new_sha" "$host"
read -r -p 'Upgrade this installation (preserving DB and credentials)? [y/N]: ' approval
[[ "$approval" == [yY] || "$approval" == [yY][eE][sS] ]] || die 'Operator declined.'

pending="$settings/.candidate-$new_sha.env"
[[ ! -e "$pending" && ! -L "$pending" ]] || die 'Unresolved prior update candidate; reconcile before retry.'
trap 'rm -f -- "$pending"' EXIT
python3 "$candidate/scripts/production/pin-update.py" "$release" "$pending" "$new_sha"
[[ -f "$site" ]] || python3 "$candidate/scripts/production/site-config.py" write "$site" "$host" >/dev/null
[[ $(docker image inspect --format '{{index .Config.Labels "io.fair-platform.owner-origin-configurable"}}' "$(sed -n 's/^API_IMAGE=//p' "$pending")") == true ]] || \
  die 'New API image does not support configurable hostname.'

old_compose=(docker compose --env-file "$release" --env-file "$site")
new_compose=(docker compose --env-file "$pending" --env-file "$site")
if [[ -f "$settings/directory.env" ]]; then
  [[ ! -L "$settings/directory.env" ]] || die 'Symlinked directory.env.'
  old_compose+=(--env-file "$settings/directory.env")
  new_compose+=(--env-file "$settings/directory.env")
  old_compose+=(-f "$previous/docker/production/compose.yml")
  new_compose+=(-f "$candidate/docker/production/compose.yml")
  if [[ "$shadow" == true ]]; then
    old_compose+=(-f "$previous/docker/production/compose.shadow.yml")
    new_compose+=(-f "$candidate/docker/production/compose.shadow.yml")
  fi
  old_compose+=(-f "$previous/docker/production/compose.directory.yml")
  new_compose+=(-f "$candidate/docker/production/compose.directory.yml")
else
  old_compose+=(-f "$previous/docker/production/compose.yml")
  new_compose+=(-f "$candidate/docker/production/compose.yml")
fi
schedule="$settings/shadow-schedule.env"
if [[ -e "$schedule" || -L "$schedule" ]]; then
  [[ -f "$schedule" && ! -L "$schedule" && $(stat -c '%u:%a' "$schedule") == 0:600 ]] || die 'Unsafe SHADOW schedule file.'
  [[ $(wc -l < "$schedule") == 1 ]] && grep -Exq 'FAIR_SHADOW_CLOSE_TIME=([01][0-9]|2[0-3]):[0-5][0-9]' "$schedule" || die 'Invalid SHADOW schedule.'
  [[ -z "$legacy_close" || $(cat "$schedule") == "FAIR_SHADOW_CLOSE_TIME=$legacy_close" ]] || die 'SHADOW schedule conflicts with installed Compose.'
elif [[ -n "$legacy_close" ]]; then
  schedule_tmp=$(mktemp "$settings/.shadow-schedule.XXXXXXXX")
  printf 'FAIR_SHADOW_CLOSE_TIME=%s\n' "$legacy_close" > "$schedule_tmp"
  mv -T -- "$schedule_tmp" "$schedule"
fi
if [[ -f "$schedule" ]]; then
  old_compose+=(--env-file "$schedule")
  new_compose+=(--env-file "$schedule")
fi
"${new_compose[@]}" config --quiet || die 'Candidate Compose invalid.'

printf 'Creating a local database dump before updating containers...\n'
bash "$previous/scripts/production/backup.sh" || die 'Database backup failed: current services were not changed.'
printf 'Local dump is NOT an off-host disaster-recovery backup.\n'
read -r -p 'I have reviewed the backup/recovery risk and approve the app-only update [y/N]: ' backup_approval
[[ "$backup_approval" == [yY] || "$backup_approval" == [yY][eE][sS] ]] || die 'Backup approval declined.'

backup_manifest="$settings/release-$old_sha.env"
if [[ -e "$backup_manifest" ]]; then
  [[ -f "$backup_manifest" && ! -L "$backup_manifest" ]] || die 'Unsafe previous release snapshot.'
  cmp -s "$release" "$backup_manifest" || die 'Previous release snapshot differs; reconcile before retry.'
else
  install -m 0600 "$release" "$backup_manifest"
fi
activated=false
rollback() {
  if [[ "$activated" == false ]]; then
    printf 'Rolling back application containers to the previous immutable release...\n' >&2
    install -m 0600 "$backup_manifest" "$release"
    "${old_compose[@]}" up -d --no-deps --wait owner-api web caddy || \
      printf 'ROLLBACK_RESTART_FAILED: manual operator reconciliation required.\n' >&2
    rm -f -- "$pending"
  fi
}
trap 'rollback' EXIT
trap 'exit 130' INT TERM
"${new_compose[@]}" up -d --no-deps --wait owner-api web caddy || die 'New release unhealthy; rolling back.'
mv -f -- "$pending" "$release"
active_tmp=$(mktemp "$settings/.active-bundle.XXXXXXXX")
printf '%s\n' "$candidate" > "$active_tmp"
chmod 0600 "$active_tmp"
mv -f -- "$active_tmp" "$settings/active-bundle"
activated=true
trap - EXIT INT TERM
printf 'PRODUCTION_UPDATE_COMPLETE %s https://%s\n' "$new_sha" "$host"
printf 'SHADOW=%s; no live billing; database volume and Owner credentials preserved.\n' "$shadow"

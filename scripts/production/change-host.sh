#!/usr/bin/env bash
# Change only the browser endpoint. No image pull, database migration or volume change.
set -euo pipefail
umask 077

die() { printf 'FAIR_OWNER_HOST_ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 && $# == 1 ]] || die 'Usage: sudo bash scripts/production/change-host.sh HOSTNAME_OR_IPV4'
[[ -t 0 ]] || die 'Private interactive terminal required.'
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
settings=/etc/fair-production
release="$settings/release.env"
site="$settings/site.env"
[[ -f "$settings/installed" ]] || die 'Installation incomplete.'
[[ -f "$site" && ! -L "$site" && $(stat -c %a "$site") == 600 && $(stat -c %u "$site") == 0 ]] || \
  die 'site.env not installed. A one-time reviewed release upgrade is needed first.'
exec 8>"$settings/setup.lock"
flock -n 8 || die 'Another setup or host change is running.'
python3 "$repo/scripts/production/preflight.py" "$release" >/dev/null
new_host=$(python3 "$repo/scripts/production/site-config.py" host "$1") || die 'Invalid hostname or IPv4 address.'
old_host=$(python3 "$repo/scripts/production/site-config.py" read "$site") || die 'Invalid current site.env.'
[[ "$new_host" != "$old_host" ]] || { printf 'OWNER_HOST_UNCHANGED %s\n' "$old_host"; exit 0; }

# Refuse old pinned deployments where editing a setting could break Owner login.
grep -Fq '${OWNER_HOST:?' "$repo/docker/production/compose.yml" || die 'Base Compose is not configurable. Review and upgrade release first.'
grep -Fq '{$OWNER_HOST} {' "$repo/docker/production/Caddyfile" || die 'Caddy configuration is not configurable. Upgrade first.'
running_image=$(docker inspect --format '{{.Image}}' fair-production-owner-api-1) || die 'Owner API not running.'
[[ $(docker image inspect --format '{{index .Config.Labels "io.fair-platform.owner-origin-configurable"}}' "$running_image") == true ]] || \
  die 'Running Owner API image still hardcodes the old origin. A one-time reviewed image upgrade is required.'
shadow=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' fair-production-owner-api-1 | sed -n 's/^FAIR_SHADOW_ENABLED=//p')
case "$shadow" in
  true) [[ -f "$settings/directory.env" ]] || die 'SHADOW directory settings missing.' ;;
  false) ;;
  *) die 'Cannot determine the running SHADOW mode.' ;;
esac
printf 'Preserving SHADOW=%s during hostname change.\n' "$shadow"

printf 'Current: https://%s\nNew:     https://%s\n' "$old_host" "$new_host"
printf 'Ensure DNS (if applicable) and public TCP/443 are ready. No database or release image will change.\n'
read -r -p 'Confirm change and restart only Owner API/Caddy [y/N]: ' answer
[[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]] || die 'Cancelled.'

compose=(docker compose --env-file "$release" --env-file "$site")
if [[ -f "$settings/directory.env" ]]; then
  [[ ! -L "$settings/directory.env" ]] || die 'Unsafe directory config.'
  compose+=(--env-file "$settings/directory.env" -f "$repo/docker/production/compose.yml")
  if [[ "$shadow" == true ]]; then
    compose+=(-f "$repo/docker/production/compose.shadow.yml")
  fi
  compose+=(-f "$repo/docker/production/compose.directory.yml")
else
  compose+=(-f "$repo/docker/production/compose.yml")
fi
changed=false
rollback() {
  trap - INT TERM
  if [[ "$changed" == true ]]; then
    printf 'Restoring previous Owner endpoint configuration...\n' >&2
    python3 "$repo/scripts/production/site-config.py" write "$site" "$old_host" >/dev/null
    "${compose[@]}" up -d --no-deps --force-recreate --wait owner-api caddy || \
      printf 'ROLLBACK_RESTART_FAILED: inspect Docker logs immediately.\n' >&2
  fi
}
trap 'rollback; exit 130' INT TERM
python3 "$repo/scripts/production/site-config.py" write "$site" "$new_host" >/dev/null
changed=true
if ! "${compose[@]}" config --quiet || ! "${compose[@]}" up -d --no-deps --force-recreate --wait owner-api caddy; then
  rollback
  die 'ROLLED_BACK_TO_PREVIOUS_HOST'
fi
changed=false
trap - INT TERM
printf 'OWNER_HOST_UPDATED https://%s\n' "$new_host"
printf 'External TLS/DNS verification: curl -fsS https://%s/health/ready\n' "$new_host"
printf 'For raw IP or localhost, Caddy may use a private CA; browsers will not automatically trust it.\n'

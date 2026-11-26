#!/usr/bin/env bash
# Owner-operated, interactive first install or existing-install directory setup.
# This script never upgrades an existing database or enables SHADOW/live billing.
set -euo pipefail
umask 077

die() { printf 'FAIR_SETUP_ERROR: %s\n' "$*" >&2; exit 1; }
ask_yes() {
  local answer
  read -r -p "$1 [y/N]: " answer
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}
ask_default_yes() {
  local answer
  read -r -p "$1 [Y/n]: " answer
  [[ -z "$answer" || "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

[[ $(id -u) -eq 0 ]] || die 'Run as root (sudo).'
[[ -t 0 && -t 1 ]] || die 'A private interactive terminal is required.'
repo=${FAIR_PRODUCTION_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
[[ -f "$repo/docker/production/compose.yml" && -f "$repo/docker/production/compose.directory.yml" ]] || die 'Deployment bundle missing.'
settings=/etc/fair-production
[[ ! -L "$settings" && ! -L "$settings/secrets" ]] || die 'Refusing symlinked production secret directories.'
release="$settings/release.env"
directory_env="$settings/directory.env"
directory_secret="$settings/secrets/pasarguard_api_key"
installed=false
[[ -f "$settings/installed" ]] && installed=true

install -d -m 0700 -o root -g root "$settings"
exec 8>"$settings/setup.lock"
flock -n 8 || die 'Another setup is running.'

if [[ "$installed" == true ]]; then
  python3 "$repo/scripts/production/preflight.py" "$release" || die 'Existing release configuration invalid.'
  printf '\nExisting Fair Platform installation found. Database and release images will remain untouched.\n'
  if docker inspect fair-production-owner-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -qx 'FAIR_SHADOW_ENABLED=true'; then
    die 'SHADOW is already active; refuse to change its deployment mode automatically.'
  fi
else
  [[ ! -e "$release" ]] || die 'Partial installation: release.env exists. Reconcile manually; no overwrite.'
  [[ ! -d "$settings/secrets" || -z $(find "$settings/secrets" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'Partial installation: secrets already exist.'
  docker volume inspect fair-production_postgres_data >/dev/null 2>&1 && die 'Existing database volume found. Refusing fresh installation.'
  printf '\nNew isolated Fair Platform installation (HTTPS Owner UI; SHADOW and billing OFF).\n'
  printf 'Domain: panel.fairisfair.ir (DNS A record must point to this server; TCP 443 available).\n'
  release_sha=$(git -C "$repo" rev-parse HEAD)
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || die 'Cannot determine exact release commit.'
  printf 'Published release commit to verify: %s\n' "$release_sha"
  ask_yes 'I reviewed this development commit and approve installing its published images' || die 'Release not approved.'
  read -r -p 'ACME certificate contact email: ' acme_email
  [[ -n "$acme_email" ]] || die 'ACME email required.'
  bash "$repo/scripts/production/resolve-release.sh" "$release_sha" "$acme_email"
  python3 "$repo/scripts/production/provision-secrets.py"
  bash "$repo/scripts/production/install.sh"
  printf '\nCreate the single Owner login. Password requires at least 16 characters; input stays hidden.\n'
  until docker compose --env-file "$release" -f "$repo/docker/production/compose.yml" \
    run --rm migrate node dist/owner/cli.js bootstrap; do
    ask_yes 'Owner bootstrap failed. Retry hidden password entry now' || die 'Owner bootstrap incomplete; request operator reconciliation before deployment.'
  done
fi

if ! ask_default_yes 'Configure the read-only PasarGuard administrator directory'; then
  printf 'FAIR_SETUP_COMPLETE_DIRECTORY_DISABLED_SHADOW_OFF\n'
  exit 0
fi

existing_url='https://pasar.fairinternet98.com'
if [[ -f "$directory_env" ]]; then
  [[ ! -L "$directory_env" ]] || die 'Directory environment is a symlink.'
  existing_url=$(sed -n 's/^PASARGUARD_BASE_URL=//p' "$directory_env")
fi
read -r -p "PasarGuard HTTPS base URL [$existing_url]: " directory_url
directory_url=${directory_url:-$existing_url}
directory_url=${directory_url%/}
python3 - "$directory_url" <<'PY' || die 'Invalid PasarGuard HTTPS URL.'
import sys
from urllib.parse import urlsplit
value = sys.argv[1]
parsed = urlsplit(value)
assert (parsed.scheme == 'https' and parsed.hostname and not parsed.username
        and not parsed.password and not parsed.port and not parsed.path and not parsed.query
        and not parsed.fragment and not any(c.isspace() for c in value)
        and value == f'https://{parsed.netloc}' and len(value) <= 255)
PY

install -d -m 0700 -o root -g root "$settings/secrets"
if [[ -e "$directory_secret" ]]; then
  [[ -f "$directory_secret" && ! -L "$directory_secret" ]] || die 'Unsafe existing API key file.'
  if ask_yes 'Replace the existing private PasarGuard API key'; then
    replace_key=true
  else
    replace_key=false
  fi
else
  replace_key=true
fi
if [[ "$replace_key" == true ]]; then
  printf 'Paste PasarGuard panel API key (hidden; never stored in release.env): '
  IFS= read -rs api_key
  printf '\n'
  [[ ${#api_key} -ge 12 && ${#api_key} -le 512 && "$api_key" != *[$'\r\n\t ']* ]] || die 'API key must be 12–512 non-whitespace characters.'
  key_tmp=$(mktemp "$settings/secrets/.pasarguard.XXXXXXXX")
  trap 'rm -f -- "${key_tmp:-}"' EXIT
  printf '%s' "$api_key" > "$key_tmp"
  unset api_key
  chown 1000:1000 "$key_tmp"
  chmod 0600 "$key_tmp"
  mv -f -- "$key_tmp" "$directory_secret"
  trap - EXIT
else
  [[ $(stat -c %a "$directory_secret") == 600 ]] || die 'Existing key must have mode 0600.'
  [[ $(stat -c %u "$directory_secret") == 1000 ]] || die 'Existing key must be owned by UID 1000.'
fi

env_tmp=$(mktemp "$settings/.directory.XXXXXXXX")
trap 'rm -f -- "${env_tmp:-}"' EXIT
printf 'PASARGUARD_BASE_URL=%s\n' "$directory_url" > "$env_tmp"
chown root:root "$env_tmp"
chmod 0600 "$env_tmp"
mv -f -- "$env_tmp" "$directory_env"
trap - EXIT

compose=(docker compose --env-file "$release" --env-file "$directory_env" \
  -f "$repo/docker/production/compose.yml" -f "$repo/docker/production/compose.directory.yml")
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --force-recreate --wait owner-api
printf 'FAIR_DIRECTORY_ACTIVE_SHADOW_OFF_NO_LIVE_BILLING\n'
printf 'Verify in browser: https://panel.fairisfair.ir/settings/groups\n'

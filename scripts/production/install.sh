#!/usr/bin/env bash
# First installation on a *new, isolated* database. Never re-run on an existing volume.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo PRODUCTION_ROOT_ONLY >&2; exit 1; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
settings=/etc/fair-production
release="$settings/release.env"
site="$settings/site.env"
[[ -f "$release" ]] || { echo PRODUCTION_RELEASE_ENV_MISSING >&2; exit 1; }
[[ $(stat -c %a "$release") == 600 ]] || { echo PRODUCTION_ENV_PERMISSIONS >&2; exit 1; }
[[ $(stat -c %u "$release") == 0 && $(stat -c %u "$settings") == 0 && $(stat -c %a "$settings") == 700 ]] || {
  echo PRODUCTION_SETTINGS_PERMISSIONS >&2; exit 1;
}
python3 "$repo/scripts/production/preflight.py" "$release"
[[ -f "$site" && ! -L "$site" && $(stat -c %a "$site") == 600 && $(stat -c %u "$site") == 0 ]] || {
  echo PRODUCTION_SITE_ENV_MISSING_OR_UNSAFE >&2; exit 1;
}
python3 "$repo/scripts/production/site-config.py" read "$site" >/dev/null
for name in postgres_password admin_database_url runtime_database_url backup_pgpass; do
  file="$settings/secrets/$name"
  [[ -f "$file" && $(stat -c %a "$file") == 600 ]] || {
    echo PRODUCTION_SECRETS_MISSING_OR_UNSAFE >&2; exit 1;
  }
done
[[ ! -e "$settings/installed" ]] || { echo PRODUCTION_ALREADY_INSTALLED >&2; exit 1; }
exec 9>"$settings/install.lock"
flock -n 9 || { echo PRODUCTION_INSTALL_BUSY >&2; exit 1; }

# Do not initialize over a partially existing/unknown Docker database.
if docker volume inspect fair-production_postgres_data >/dev/null 2>&1; then
  echo PRODUCTION_EXISTING_POSTGRES_VOLUME_STOP_AND_RECONCILE >&2
  exit 1
fi
if ss -H -ltn '( sport = :443 )' | grep -q .; then
  echo PRODUCTION_PORT_443_IN_USE >&2
  exit 1
fi

# Read only the trusted root-owned release manifest, without shell evaluation.
mapfile -t release_fields < <(python3 - "$release" "$repo" <<'PY'
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[2]) / 'scripts/production'))
from preflight import validate
v = validate(Path(sys.argv[1]))
tip = subprocess.check_output(['git', '-C', sys.argv[2], 'rev-parse', 'HEAD'], text=True).strip()
assert tip == v['RELEASE_SHA'], 'PRODUCTION_CHECKOUT_SHA_MISMATCH'
print(v['RELEASE_SHA'])
for key in ('API_IMAGE', 'WEB_IMAGE', 'CADDY_IMAGE', 'POSTGRES_IMAGE'):
    print(v[key])
PY
)
[[ ${#release_fields[@]} == 5 ]] || { echo PRODUCTION_CHECKOUT_INVALID >&2; exit 1; }
compose=(docker compose --env-file "$release" --env-file "$site" -f "$repo/docker/production/compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" pull
for image in "${release_fields[@]:1}"; do
  source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [[ "$source" == https://github.com/h-zare-dev/fair-platform && "$revision" == "${release_fields[0]}" ]] || {
    echo PRODUCTION_IMAGE_PROVENANCE_MISMATCH >&2; exit 1;
  }
done

"${compose[@]}" up -d postgres
ready=false
for _ in $(seq 1 90); do
  if "${compose[@]}" exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql -h 127.0.0.1 -U fair_migrator -d fair_platform -w -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo PRODUCTION_POSTGRES_NOT_READY >&2; exit 1; }
"${compose[@]}" run --rm -T migrate
"${compose[@]}" exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U fair_migrator -d fair_platform < "$repo/docker/production/runtime-grants.sql" >/dev/null
python3 - "$settings" <<'PY' | "${compose[@]}" exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U fair_migrator -d fair_platform >/dev/null
import re,sys
from pathlib import Path
for role, name in [('fair_owner_runtime','runtime_role_password'), ('fair_backup','backup_role_password')]:
    password = (Path(sys.argv[1])/name).read_text()
    assert re.fullmatch('[0-9a-f]{64}', password)
    print(f"ALTER ROLE {role} PASSWORD '{password}';")
PY
"${compose[@]}" up -d --wait owner-api web caddy
install -m 0600 /dev/null "$settings/installed"
printf 'PRODUCTION_OWNER_UI_INSTALLED_SHADOW_OFF_NO_LIVE_BILLING\n'

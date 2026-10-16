#!/usr/bin/env bash
# One-time Owner-triggered bootstrap of an empty Ubuntu 26.04 test VPS.
set -euo pipefail
umask 077
ROOT=/opt/fair-staging
SETTINGS=/etc/fair-staging
mode="${1:-}"
[[ $(id -u) -eq 0 ]] || { echo 'BOOTSTRAP_REQUIRES_ROOT'; exit 1; }
[[ -f /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] || { echo 'BOOTSTRAP_REQUIRES_UBUNTU_26_04'; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'BOOTSTRAP_REQUIRES_AMD64'; exit 1; }
[[ "$mode" == prepare || "$mode" == pull || "$mode" == start ]] || exit 2
[[ -f "$ROOT/bootstrap-release.json" && -f "$ROOT/compose.yml" && -f "$ROOT/Caddyfile" ]] || exit 2
python3 - "$ROOT/bootstrap-release.json" <<'PY'
import json,re,sys
v=json.load(open(sys.argv[1]))
assert set(v)=={'sha','api','web','caddy','postgres','schema','configHash','acmeEmail'}
assert re.fullmatch('[a-f0-9]{40}',v['sha']) and v['schema']=='fp003b-v1'
assert re.fullmatch('[a-f0-9]{64}',v['configHash'])
assert re.fullmatch('[A-Za-z0-9_.+@-]+',v['acmeEmail'])
for k,n in [('api','owner-api'),('web','web'),('caddy','caddy'),('postgres','postgres')]:
 assert re.fullmatch('ghcr.io/h-zare-dev/fair-platform-'+n+'@sha256:[a-f0-9]{64}',v[k])
PY
if [[ "$mode" == prepare ]]; then
  [[ ! -e "$ROOT/current.json" && ! -e "$ROOT/current.env" ]] || { echo 'BOOTSTRAP_ALREADY_ACCEPTED'; exit 1; }
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends docker.io docker-compose-v2 ufw ca-certificates curl openssl python3
  systemctl enable --now docker
  docker compose version >/dev/null
  [[ -z "$(docker ps -aq)" ]] || { echo 'BOOTSTRAP_REQUIRES_EMPTY_DOCKER_HOST'; exit 1; }
  # Preserve SSH before enabling UFW.
  ufw allow 22/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  ufw status | grep -q 'Status: active'
  mkdir -p "$SETTINGS/secrets"
  chmod 700 "$SETTINGS" "$SETTINGS/secrets"
  chmod 600 "$ROOT/bootstrap-release.json"
  if [[ ! -e "$SETTINGS/secrets/postgres_password" ]]; then
    python3 - "$SETTINGS" <<'PY'
from pathlib import Path
import secrets,os,sys
base=Path(sys.argv[1]); d=base/'secrets'
p=secrets.token_hex(32); r=secrets.token_hex(32); b=secrets.token_hex(32)
data={'postgres_password':p,
 'admin_database_url':f'postgresql://fair_migrator:{p}@postgres:5432/fair_staging',
 'runtime_database_url':f'postgresql://fair_owner_runtime:{r}@postgres:5432/fair_staging',
 'seed_encryption_key':secrets.token_hex(32),
 'backup_pgpass':f'postgres:5432:fair_staging:fair_backup:{b}\n'}
for k,v in data.items():
 path=d/k
 with path.open('x') as f: f.write(v)
 os.chmod(path,0o600)
for k,v in {'runtime_role_password':r,'backup_role_password':b}.items():
 with (base/k).open('x') as f:f.write(v)
 os.chmod(base/k,0o600)
for name in ('admin_database_url','runtime_database_url','seed_encryption_key'):
 os.chown(d/name,1000,1000)
os.chown(d/'backup_pgpass',70,70)
PY
  fi
  python3 - "$ROOT/bootstrap-release.json" "$ROOT/current.env" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
keys={'API_IMAGE':'api','WEB_IMAGE':'web','CADDY_IMAGE':'caddy','POSTGRES_IMAGE':'postgres','ACME_EMAIL':'acmeEmail'}
with open(sys.argv[2],'x') as f:
 for a,b in keys.items(): f.write(f'{a}={v[b]}\n')
 f.write('SECRETS_DIR=/etc/fair-staging/secrets\n')
PY
  chmod 600 "$ROOT/current.env"
  printf '{"approval":"DISABLED","schema":"fp003b-v1"}\n' > "$SETTINGS/activation.json"
  chmod 600 "$SETTINGS/activation.json"
  echo 'BOOTSTRAP_PREPARED'
  exit 0
fi
[[ -f "$ROOT/current.env" && -d "$SETTINGS/secrets" ]] || { echo 'BOOTSTRAP_NOT_PREPARED'; exit 1; }
cd "$ROOT"
compose=(docker compose --env-file "$ROOT/current.env" -f "$ROOT/compose.yml")
if [[ "$mode" == pull ]]; then
  config=$(mktemp -d)
  trap 'rm -rf "$config"' EXIT
  export DOCKER_CONFIG="$config"
  # Ephemeral GitHub package token comes over pinned SSH stdin only.
  docker login ghcr.io -u h-zare-dev --password-stdin >/dev/null
  python3 - "$ROOT/bootstrap-release.json" <<'PY' | while IFS= read -r image; do docker pull "$image" >/dev/null; done
import json,sys
r=json.load(open(sys.argv[1]))
for name in ('api','web','caddy','postgres'):print(r[name])
PY
  echo 'BOOTSTRAP_IMAGES_PULLED'
  exit 0
fi
[[ ! -e "$ROOT/current.json" ]] || { echo 'BOOTSTRAP_ALREADY_ACCEPTED'; exit 1; }
"${compose[@]}" up -d postgres
# Socket readiness can be satisfied by PostgreSQL's temporary initialization server;
# require the final TCP listener and actual SQL before migrations.
ready=false
for _ in $(seq 1 90); do
  if "${compose[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U fair_migrator -t 1 >/dev/null 2>&1 &&
     "${compose[@]}" exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql -h 127.0.0.1 -U fair_migrator -d fair_staging -w -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'POSTGRES_FINAL_SERVER_NOT_READY'; exit 1; }
"${compose[@]}" run --rm --no-deps -T migrate
"${compose[@]}" exec -T postgres psql -U fair_migrator -d fair_staging -v ON_ERROR_STOP=1 < "$ROOT/runtime-grants.sql" >/dev/null
python3 - "$SETTINGS" <<'PY' | "${compose[@]}" exec -T postgres psql -U fair_migrator -d fair_staging -v ON_ERROR_STOP=1 >/dev/null
from pathlib import Path
import sys
p=Path(sys.argv[1])
for role,file in [('fair_owner_runtime','runtime_role_password'),('fair_backup','backup_role_password')]:
 password=(p/file).read_text()
 assert len(password)==64 and all(c in '0123456789abcdef' for c in password)
 print(f"ALTER ROLE {role} PASSWORD '{password}';")
PY
"${compose[@]}" up -d --wait owner-api web caddy
# The GitHub-hosted runner separately validates public TLS and login.
python3 - "$ROOT/bootstrap-release.json" "$ROOT/current.json" <<'PY'
import json,os,sys
from pathlib import Path
v=json.loads(Path(sys.argv[1]).read_text()); v.pop('acmeEmail')
p=Path(sys.argv[2]);p.write_text(json.dumps(v));os.chmod(p,0o600)
PY
printf 'BOOTSTRAP_STACK_RUNNING_NO_OWNER_NO_SEED\n'

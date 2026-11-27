#!/usr/bin/env bash
# One public entry point: install | update | host | directory. Fetch deployment files only.
set -euo pipefail
umask 077

die() { printf 'FAIR_BOOTSTRAP_ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die 'Run as root (sudo).'
[[ -t 0 && -t 1 ]] || die 'Use a private interactive terminal.'
[[ $(uname -m) == x86_64 ]] || die 'Published images require amd64.'
[[ -r /etc/os-release ]] || die 'Ubuntu required.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == ubuntu ]] || die 'Ubuntu required.'

mode=${1:-auto}
[[ $# -le 2 ]] || die 'Usage: fair-platform-install.sh [install|update|host|directory]'
installed=false
[[ -f /etc/fair-production/installed ]] && installed=true
if [[ "$mode" == auto ]]; then
  if [[ "$installed" == true ]]; then
    printf 'Fair Platform is installed. Choose: [u]pdate / change [h]ost / [d]irectory: '
    read -r choice
    case "$choice" in
      u|U) mode=update ;;
      h|H) mode=host ;;
      d|D) mode=directory ;;
      *) die 'Invalid menu selection.' ;;
    esac
  else
    mode=install
  fi
fi
case "$mode" in
  install) [[ "$installed" == false ]] || die 'Already installed; use update.' ;;
  update|host|directory) [[ "$installed" == true ]] || die 'Not installed; use install.' ;;
  *) die 'Usage: fair-platform-install.sh [install|update|host|directory]' ;;
esac

if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || \
   ! command -v ss >/dev/null || ! command -v flock >/dev/null || \
   ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  read -r -p 'Install missing Ubuntu Docker/Compose and deployment prerequisites via apt? [y/N]: ' consent
  [[ "$consent" == [yY] || "$consent" == [yY][eE][sS] ]] || die 'Prerequisite install declined.'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 python3 curl util-linux iproute2
  systemctl enable --now docker
fi
docker info >/dev/null 2>&1 || die 'Docker daemon unavailable.'
if [[ "$installed" == true ]]; then
  exec 7>/etc/fair-production/bootstrap.lock
  flock -n 7 || die 'Another installer invocation is running.'
fi

registry=ghcr.io/h-zare-dev/fair-platform-deploy
legacy=/opt/fair-platform
releases=/opt/fair-production-releases
active_file=/etc/fair-production/active-bundle
if [[ "$installed" == true ]]; then
  if [[ -e "$active_file" || -L "$active_file" ]]; then
    [[ -f "$active_file" && ! -L "$active_file" && $(stat -c %u "$active_file") == 0 ]] || die 'Unsafe active release pointer.'
    IFS= read -r active < "$active_file"
    [[ "$active" =~ ^/opt/fair-production-releases/[0-9a-f]{40}$ && -d "$active" ]] || die 'Invalid active release pointer.'
  else
    active=$legacy
  fi
  [[ -f "$active/docker/production/compose.yml" && -f "$active/scripts/production/backup.sh" ]] || \
    die 'Active production deployment bundle is missing. Nothing modified.'
fi

if [[ "$mode" == install || "$mode" == update ]]; then
  settings=/etc/fair-production
  install -d -m 0700 "$settings"
  if [[ "$installed" == false ]]; then
    exec 7>"$settings/bootstrap.lock"
    flock -n 7 || die 'Another installation is running.'
  fi
  default_channel=latest
  if [[ -f "$settings/channel" ]]; then read -r default_channel < "$settings/channel"; fi
  channel=${2:-}
  if [[ -z "$channel" ]]; then
    read -r -p "Channel: latest (stable), dev, or vX.Y.Z [$default_channel]: " channel
    channel=${channel:-$default_channel}
  fi
  [[ "$channel" =~ ^(latest|dev|v[0-9]+\.[0-9]+\.[0-9]+)$ ]] || die 'Invalid channel.'
  docker pull "$registry:$channel"
  image=$(docker image inspect --format '{{.Id}}' "$registry:$channel")
  sha=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'Invalid bundle revision.'
  install -d -m 0755 -o root -g root "$releases"
  candidate="$releases/$sha"
  stage=$(mktemp -d "$releases/.incoming.XXXXXXXX")
  container=''
  cleanup() {
    if [[ -n "$container" ]]; then docker rm "$container" >/dev/null || true; fi
    rm -rf -- "$stage"
  }
  trap cleanup EXIT
  container=$(docker create --network none "$image" /unused)
  docker cp "$container:/bundle/." "$stage/"
  [[ $(cat "$stage/REVISION") == "$sha" ]] || die 'Bundle revision mismatch.'
  if [[ -e "$candidate" ]]; then
    [[ ! -L "$candidate" ]] && diff -qr --exclude=__pycache__ "$candidate" "$stage" >/dev/null || die 'Existing bundle differs.'
  else
    mv -T -- "$stage" "$candidate"
  fi
  export PYTHONDONTWRITEBYTECODE=1
  if [[ "$mode" == install ]]; then
    # Persist the location even if optional directory setup is interrupted.
    printf '%s\n' "$candidate" > "$settings/active-bundle"
    bash "$candidate/scripts/production/setup.sh"
  elif [[ $(sed -n 's/^RELEASE_SHA=//p' "$settings/release.env") != "$sha" ]]; then
    bash "$candidate/scripts/production/upgrade.sh" "$candidate" "$active"
  fi
  printf '%s\n' "$channel" > "$settings/channel"
elif [[ "$mode" == host ]]; then
  [[ -f "$active/scripts/production/change-host.sh" ]] || die 'Upgrade the old production release first.'
  read -r -p 'New panel hostname, IPv4 or localhost: ' new_host
  bash "$active/scripts/production/change-host.sh" "$new_host"
else
  [[ -f "$active/scripts/production/setup.sh" ]] || die 'Active deployment setup missing.'
  FAIR_PRODUCTION_REPO="$active" bash "$active/scripts/production/setup.sh"
fi

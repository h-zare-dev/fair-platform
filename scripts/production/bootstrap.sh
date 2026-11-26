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
[[ $# -le 1 ]] || die 'Usage: fair-platform-install.sh [install|update|host|directory]'
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

if ! command -v git >/dev/null || ! command -v python3 >/dev/null || \
   ! command -v ss >/dev/null || ! command -v flock >/dev/null || \
   ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  read -r -p 'Install missing Ubuntu Docker/Compose and deployment prerequisites via apt? [y/N]: ' consent
  [[ "$consent" == [yY] || "$consent" == [yY][eE][sS] ]] || die 'Prerequisite install declined.'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git python3 curl util-linux iproute2
  systemctl enable --now docker
fi
docker info >/dev/null 2>&1 || die 'Docker daemon unavailable.'
if [[ "$installed" == true ]]; then
  exec 7>/etc/fair-production/bootstrap.lock
  flock -n 7 || die 'Another installer invocation is running.'
fi

origin=https://github.com/h-zare-dev/fair-platform.git
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

if [[ "$mode" == install ]]; then
  [[ ! -e "$legacy" ]] || die 'Existing /opt/fair-platform. Cannot overwrite a partial installation.'
  printf 'Fetching only production Compose and scripts; application source is not needed.\n'
  git clone --depth=1 --filter=blob:none --sparse --branch development --single-branch "$origin" "$legacy"
  git -C "$legacy" sparse-checkout set docker/production scripts/production
  bash "$legacy/scripts/production/setup.sh"
elif [[ "$mode" == update ]]; then
  remote_tip=$(git ls-remote "$origin" refs/heads/development)
  read -r sha _ <<< "$remote_tip"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'Cannot verify development release SHA.'
  current=$(sed -n 's/^RELEASE_SHA=//p' /etc/fair-production/release.env)
  [[ "$current" =~ ^[0-9a-f]{40}$ ]] || die 'Installed release is invalid.'
  [[ "$sha" != "$current" ]] || { printf 'PRODUCTION_ALREADY_UP_TO_DATE %s\n' "$sha"; exit 0; }
  install -d -m 0755 -o root -g root "$releases"
  candidate="$releases/$sha"
  [[ ! -L "$candidate" ]] || die 'Candidate release path is a symlink.'
  if [[ ! -e "$candidate" ]]; then
    printf 'Fetching a deployment bundle for reviewed commit %s\n' "$sha"
    git clone --depth=1 --filter=blob:none --sparse --branch development --single-branch "$origin" "$candidate"
    git -C "$candidate" sparse-checkout set docker/production scripts/production
  fi
  [[ -d "$candidate/.git" && $(git -C "$candidate" rev-parse HEAD) == "$sha" ]] || die 'Candidate checkout not pinned to expected SHA.'
  [[ $(git -C "$candidate" remote get-url origin) == "$origin" ]] || die 'Candidate repository origin invalid.'
  [[ -z $(git -C "$candidate" status --porcelain -- docker/production scripts/production) ]] || die 'Candidate bundle modified; do not run.'
  bash "$candidate/scripts/production/upgrade.sh" "$candidate" "$active"
elif [[ "$mode" == host ]]; then
  [[ -f "$active/scripts/production/change-host.sh" ]] || die 'Upgrade the old production release first.'
  read -r -p 'New panel hostname, IPv4 or localhost: ' new_host
  bash "$active/scripts/production/change-host.sh" "$new_host"
else
  [[ -f "$active/scripts/production/setup.sh" ]] || die 'Active deployment setup missing.'
  FAIR_PRODUCTION_REPO="$active" bash "$active/scripts/production/setup.sh"
fi

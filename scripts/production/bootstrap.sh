#!/usr/bin/env bash
# curl -fsSLo /root/fair-platform-install.sh URL && bash /root/fair-platform-install.sh
# Fetches only deployment tooling. Never performs automatic production upgrades.
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

repo=/opt/fair-platform
origin=https://github.com/h-zare-dev/fair-platform.git
if [[ -e "$repo" ]]; then
  [[ -d "$repo" && -f "$repo/docker/production/compose.yml" && -f "$repo/scripts/production/preflight.py" ]] || die 'Existing /opt/fair-platform is not a known deployment bundle. Nothing modified.'
  [[ -f /etc/fair-production/installed ]] || die 'Existing checkout but no completed installation. Reconcile manually.'
  printf 'Fetching only the read-only directory overlay and guided setup tooling.\n'
  temp_dir=$(mktemp -d)
  trap 'rm -rf -- "$temp_dir"' EXIT
  if [[ -d "$repo/.git" ]]; then
    [[ $(git -C "$repo" remote get-url origin) == "$origin" ]] || die 'Existing checkout has unexpected origin.'
    git -C "$repo" fetch --depth=1 origin development
    sha=$(git -C "$repo" rev-parse FETCH_HEAD)
    git -C "$repo" show "$sha:docker/production/compose.directory.yml" > "$temp_dir/compose.directory.yml"
    git -C "$repo" show "$sha:scripts/production/setup.sh" > "$temp_dir/setup.sh"
  else
    # Hosts can intentionally retain only deployment files, with no .git or source.
    read -r sha _ < <(git ls-remote "$origin" refs/heads/development)
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'Cannot pin deployment bundle revision.'
    curl -fsSLo "$temp_dir/compose.directory.yml" "https://raw.githubusercontent.com/h-zare-dev/fair-platform/$sha/docker/production/compose.directory.yml"
    curl -fsSLo "$temp_dir/setup.sh" "https://raw.githubusercontent.com/h-zare-dev/fair-platform/$sha/scripts/production/setup.sh"
  fi
  # Never run an unreviewed/locally altered base Compose definition as root.
  release_sha=$(sed -n 's/^RELEASE_SHA=//p' /etc/fair-production/release.env)
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || die 'Installed release SHA missing or invalid.'
  curl -fsSLo "$temp_dir/pinned-compose.yml" "https://raw.githubusercontent.com/h-zare-dev/fair-platform/$release_sha/docker/production/compose.yml"
  cmp -s "$temp_dir/pinned-compose.yml" "$repo/docker/production/compose.yml" || die 'Existing base Compose differs from the installed pinned release; stop and reconcile.'
  if [[ -e "$repo/docker/production/compose.directory.yml" ]]; then
    cmp -s "$temp_dir/compose.directory.yml" "$repo/docker/production/compose.directory.yml" || die 'Existing directory overlay differs; no overwrite.'
  else
    install -m 0644 "$temp_dir/compose.directory.yml" "$repo/docker/production/compose.directory.yml"
  fi
  FAIR_PRODUCTION_REPO="$repo" bash "$temp_dir/setup.sh"
else
  [[ ! -e /etc/fair-production/installed ]] || die 'Installed marker exists but checkout is missing. Stop and reconcile.'
  printf 'Fetching only production Compose and scripts; application source is not needed on host.\n'
  git clone --depth=1 --filter=blob:none --sparse --branch development --single-branch "$origin" "$repo"
  git -C "$repo" sparse-checkout set docker/production scripts/production
  printf 'Deployment checkout pinned at %s\n' "$(git -C "$repo" rev-parse HEAD)"
  bash "$repo/scripts/production/setup.sh"
fi

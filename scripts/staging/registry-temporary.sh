#!/usr/bin/env bash
# Transient GitHub Actions package-read token. Never retain it across releases.
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $# == 1 ]]
config=/run/fair-staging-docker-auth
case "$1" in
  login)
    install -d -m 0700 -o root -g root "$config"
    [[ ! -L "$config" ]]
    DOCKER_CONFIG="$config" docker login ghcr.io -u h-zare-dev --password-stdin >/dev/null
    [[ -f "$config/config.json" ]]
    ;;
  logout)
    if [[ -f "$config/config.json" ]]; then
      DOCKER_CONFIG="$config" docker logout ghcr.io >/dev/null 2>&1 || true
      rm -f -- "$config/config.json"
    fi
    rmdir -- "$config" 2>/dev/null || true
    ;;
  *) exit 2 ;;
esac

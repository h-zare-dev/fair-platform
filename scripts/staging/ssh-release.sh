#!/usr/bin/env bash
set -euo pipefail
# Install root-owned; allow only this exact no-argument sudo command for deploy user.
[[ $# == 0 && "${SSH_ORIGINAL_COMMAND:-}" == 'fair-staging-release' ]] || exit 1
exec sudo -n /opt/fair-staging/tooling/release.py

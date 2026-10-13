#!/usr/bin/env bash
set -euo pipefail
# Root-owned file, operator configured. Never source inputs supplied by SSH callers.
set -a
source /etc/fair-staging/backup.env
set +a
exec /opt/fair-staging/tooling/backup.sh

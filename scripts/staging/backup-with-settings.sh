#!/usr/bin/env bash
set -euo pipefail
# Root-owned file, operator configured. Never source inputs supplied by SSH callers.
set -a
source /etc/fair-staging/backup.env
set +a
case "${BACKUP_POLICY:-offsite}" in
  offsite) exec /opt/fair-staging/tooling/backup.sh ;;
  local-verified-v1) exec /opt/fair-staging/tooling/backup-local.sh ;;
  *) printf 'BACKUP_POLICY_UNSUPPORTED\n' >&2; exit 1 ;;
esac

#!/usr/bin/env bash
set -euo pipefail
# curl validates public CA chain, hostname and expiration; no -k or HTTP fallback.
curl --fail --silent --show-error --max-time 15 --proto '=https' https://panel.fairisfair.ir/health/ready >/dev/null 2>&1 || { printf 'PUBLIC_HTTPS_HEALTH_FAILED\n'; exit 1; }
end=$(timeout 15s openssl s_client -connect panel.fairisfair.ir:443 -servername panel.fairisfair.ir </dev/null 2>/dev/null | openssl x509 -noout -enddate)
expiry=$(date -d "${end#notAfter=}" +%s)
(( expiry - $(date +%s) > 7*86400 )) || { printf 'CERTIFICATE_EXPIRY_ALERT\n'; exit 1; }
printf 'PUBLIC_HTTPS_HEALTH_OK\n'

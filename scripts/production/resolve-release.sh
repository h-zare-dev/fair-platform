#!/usr/bin/env bash
# Pin a reviewed published development SHA to four immutable GHCR digests.
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $# == 2 ]] || { echo 'USAGE_ROOT: resolve-release.sh REVIEWED_SHA ACME_EMAIL' >&2; exit 1; }
sha=$1
acme_email=$2
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo PRODUCTION_SHA_INVALID >&2; exit 1; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ $(cat "$repo/REVISION") == "$sha" ]] || { echo PRODUCTION_CHECKOUT_SHA_MISMATCH >&2; exit 1; }
settings=/etc/fair-production
install -d -m 0700 -o root -g root "$settings"
[[ ! -e "$settings/release.env" ]] || { echo PRODUCTION_RELEASE_ENV_ALREADY_EXISTS >&2; exit 1; }
tmp=$(mktemp "$settings/.release.XXXXXXXX")
trap 'rm -f -- "$tmp"' EXIT
printf 'RELEASE_SHA=%s\n' "$sha" >"$tmp"
for pair in API:owner-api WEB:web CADDY:caddy POSTGRES:postgres; do
  key=${pair%%:*}
  name=${pair#*:}
  image="ghcr.io/h-zare-dev/fair-platform-$name"
  tag="$image:$sha"
  docker pull "$tag" >/dev/null
  [[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$tag") == https://github.com/h-zare-dev/fair-platform ]] || {
    echo PRODUCTION_IMAGE_SOURCE_INVALID >&2; exit 1;
  }
  [[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag") == "$sha" ]] || {
    echo PRODUCTION_IMAGE_REVISION_INVALID >&2; exit 1;
  }
  digest=$(docker image inspect --format '{{json .RepoDigests}}' "$tag" | python3 -c '
import json,re,sys
prefix=sys.argv[1]+"@sha256:"
matches=[d for d in json.load(sys.stdin) if d.startswith(prefix) and re.fullmatch(r"[a-f0-9]{64}",d[len(prefix):])]
assert len(matches)==1, "PRODUCTION_IMAGE_DIGEST_UNAVAILABLE"
print(matches[0])
' "$image")
  printf '%s_IMAGE=%s\n' "$key" "$digest" >>"$tmp"
done
printf 'SECRETS_DIR=/etc/fair-production/secrets\nACME_EMAIL=%s\nFAIR_REPORT_CALENDAR=jalali\nFAIR_REPORT_WEEK_START_DAY=SATURDAY\n' "$acme_email" >>"$tmp"
python3 "$repo/scripts/production/preflight.py" "$tmp" >/dev/null
chmod 0600 "$tmp"
mv -n -- "$tmp" "$settings/release.env"
[[ -f "$settings/release.env" ]] || { echo PRODUCTION_RELEASE_ENV_WRITE_FAILED >&2; exit 1; }
printf 'PRODUCTION_IMMUTABLE_RELEASE_PINNED %s\n' "$sha"

#!/usr/bin/env bash
set -euo pipefail
prefix="ghcr.io/$GITHUB_REPOSITORY"
channel=dev
version=$(cat VERSION)
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
if [[ "$GITHUB_REF_NAME" == main ]]; then
  channel=latest
  # Never move a released version tag to another commit.
  existing=$(git ls-remote origin "refs/tags/$version" "refs/tags/$version^{}")
  if [[ -n "$existing" ]]; then
    [[ $(awk 'END {print $1}' <<<"$existing") == "$GITHUB_SHA" ]] || { echo 'Bump VERSION before publishing.' >&2; exit 1; }
  fi
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
python3 scripts/release/package-bundle.py "$work/payload"
printf 'FROM scratch\nCOPY payload/ /bundle/\n' > "$work/Dockerfile"
docker build --label "org.opencontainers.image.source=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \
  --label "org.opencontainers.image.revision=$GITHUB_SHA" -t "$prefix-deploy:$GITHUB_SHA" "$work"
docker push "$prefix-deploy:$GITHUB_SHA"
# Move the installer channel only after all four runtime images are available.
for service in owner-api web caddy postgres deploy; do
  ref="$prefix-$service"
  docker pull "$ref:$GITHUB_SHA"
  if [[ "$channel" == latest ]]; then
    docker tag "$ref:$GITHUB_SHA" "$ref:$version"
    docker push "$ref:$version"
  fi
  docker tag "$ref:$GITHUB_SHA" "$ref:$channel"
  docker push "$ref:$channel"
done
if [[ "$channel" == latest ]]; then
  if ! gh release view "$version" >/dev/null 2>&1; then
    gh release create "$version" scripts/production/bootstrap.sh#fair-platform-install.sh \
      --target "$GITHUB_SHA" --title "$version" --generate-notes --latest
  fi
fi

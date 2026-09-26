#!/usr/bin/env bash
# push-image.sh <version> — build the release image and push it to the local
# registry (real registry semantics: digest-addressed, pull-on-deploy).
set -euo pipefail
cd "$(dirname "$0")/.."

# pick up LOCAL_REGISTRY / port overrides from the-stage/.env if present
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in LOCAL_REGISTRY|REGISTRY_PORT|PROD_APP_PORT|TWIN_APP_PORT) export "$k=$v" ;; esac
  done < <(grep -v '^#' .env | grep -v '^$')
fi

VERSION="${1:?usage: push-image.sh <version>  e.g. v2.2.0}"
REGISTRY="${LOCAL_REGISTRY:-http://localhost:5555}"
REGISTRY_HOST="${REGISTRY#http://}"

echo "🔨 Building fake-prod:${VERSION} (release baked into the image)"
docker build -q --build-arg APP_VERSION="${VERSION}" -t "fake-prod:${VERSION}" fake-prod/

# always have a known-good fallback in the registry too
if [ ! "${VERSION}" = "v1.42.0" ]; then
  docker image inspect "fake-prod:v1.42.0" >/dev/null 2>&1 || docker build -q --build-arg APP_VERSION=v1.42.0 -t "fake-prod:v1.42.0" fake-prod/
  docker tag "fake-prod:v1.42.0" "${REGISTRY_HOST}/fake-prod:v1.42.0"
  docker push -q "${REGISTRY_HOST}/fake-prod:v1.42.0" || true
fi

echo "🏷  Tagging for registry: ${REGISTRY_HOST}/fake-prod:${VERSION}"
docker tag "fake-prod:${VERSION}" "${REGISTRY_HOST}/fake-prod:${VERSION}"

echo "📦 Pushing to ${REGISTRY_HOST}"
docker push "${REGISTRY_HOST}/fake-prod:${VERSION}"

echo "✅ ${REGISTRY_HOST}/fake-prod:${VERSION} is in the registry."
echo "   Catalog: curl ${REGISTRY}/v2/_catalog"

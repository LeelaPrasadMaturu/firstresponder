#!/usr/bin/env bash
# deploy-image.sh <version> <prod|twin> — pull the exact image from the
# registry and roll it out (force-recreate = new container, same as a k8s
# rollout in spirit). Rollback = re-run with the previous version.
set -euo pipefail
cd "$(dirname "$0")/.."

# pick up LOCAL_REGISTRY / port overrides from the-stage/.env if present
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in LOCAL_REGISTRY|REGISTRY_PORT|PROD_APP_PORT|TWIN_APP_PORT) export "$k=$v" ;; esac
  done < <(grep -v '^#' .env | grep -v '^$')
fi

VERSION="${1:?usage: deploy-image.sh <version> <prod|twin>}"
TARGET="${2:?usage: deploy-image.sh <version> <prod|twin>}"
REGISTRY="${LOCAL_REGISTRY:-http://localhost:5555}"
REGISTRY_HOST="${REGISTRY#http://}"
IMAGE="${REGISTRY_HOST}/fake-prod:${VERSION}"

echo "⬇️  Pulling ${IMAGE}"
docker pull -q "${IMAGE}"

if [ "$TARGET" = "prod" ]; then
  echo "🚀 Rolling out PROD → ${IMAGE}"
  PROD_IMAGE="$IMAGE" docker compose up -d --no-deps --force-recreate app
  sleep 2
  curl -s "http://localhost:${PROD_APP_PORT:-8080}/admin/state" | grep -o "\"version\":\"[^\"]*\"" || true
else
  echo "🚀 Rolling out TWIN → ${IMAGE}"
  TWIN_IMAGE="$IMAGE" docker compose up -d --no-deps --force-recreate twin-app
  sleep 2
  curl -s "http://localhost:${TWIN_APP_PORT:-8081}/admin/state" | grep -o "\"version\":\"[^\"]*\"" || true
fi

echo "✅ ${TARGET} is now running ${VERSION}. (Undo: deploy-image.sh <old-version> ${TARGET})"

#!/usr/bin/env bash
set -euo pipefail

# clean.prod.sh
# Runs on the CLOUD SERVER, after the stack is up and answering. Removes the
# extracted sources (already baked into the images) and prunes stale image tags.

set -a
source ../.docker/.config.env.tools
set +a

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_subheader "🛠️  [5/5] Cleanup [$URL_NAME]"

echo "🧹 Cleaning up build sources: $(pwd)"
cd "$ROOT_DIR"

# Drop the source trees — they exist only to feed `docker build`, and the images
# are built by now. `.docker`, the manifests and `.env.production` stay behind
# so an operator can re-apply or roll back the stack from the host without a
# full redeploy.
rm -rf apps packages infra assets .tmp
chmod 600 .env.production 2>/dev/null || true

new_line
echo "🧹 Pruning old images (keeping newest 3 per repo)"
# Per-build tags accumulate. Keep the running one plus a couple to roll back to.
for repo in "$DOCKER_IMAGE_API_BASE" "$DOCKER_IMAGE_WEB_BASE"; do
  docker images "$repo" --format '{{.ID}}' | tail -n +4 \
    | xargs -r docker rmi -f >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null 2>&1 || true

new_line
echo "✅ [$URL_NAME] deployed successfully!"
new_line

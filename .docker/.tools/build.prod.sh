#!/bin/bash

# build.prod.sh
# Runs on the CLOUD SERVER. Builds both production images from the monorepo root.

set -e

if [[ -z "$ROOT_DIR"      || \
      -z "$SHARED_DIR"    || \
      -z "$TOOLS_DIR"     || \
      -z "$SCRIPTS_INCLUDE" ]]; then
  echo "ENV values missing"
  exit 1
fi

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_subheader "🛠️  [1/5] Building production images"

echo "🌐 Environment"
echo "  🔹 PATH=$(pwd)"
echo "  🔹 MODE=$MODE"
echo "  🔹 STACK_NAME=$STACK_NAME"
echo "  🔹 ROOT_DIR=$ROOT_DIR"
echo "  🔹 SHARED_DIR=$SHARED_DIR"
echo "  🔹 TOOLS_DIR=$TOOLS_DIR"
echo "  🔹 DOCKER_IMAGE_API=$DOCKER_IMAGE_API"
echo "  🔹 DOCKER_IMAGE_WEB=$DOCKER_IMAGE_WEB"
new_line

cd "$ROOT_DIR"

# Build context is the workspace root for both images — the Dockerfiles COPY
# manifests from packages/* and apps/* to reconstruct the pnpm workspace.
echo "🛠️  Building API image..."
docker build --no-cache -f .docker/Dockerfile.api -t "$DOCKER_IMAGE_API" .
echo "🛠️  Building web image..."
docker build --no-cache -f .docker/Dockerfile.web -t "$DOCKER_IMAGE_WEB" .

new_line
echo "🎉 Docker images build complete."

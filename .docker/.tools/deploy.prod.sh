#!/bin/bash

# deploy.prod.sh
# Runs on the CLOUD SERVER. Applies the stack via Docker Swarm (rolling update).

set -e

if [[ -z "$ROOT_DIR"          || \
      -z "$SHARED_DIR"        || \
      -z "$TOOLS_DIR"         || \
      -z "$STACK_NAME"        || \
      -z "$COMPOSE_FILE_PATH" || \
      -z "$SCRIPTS_INCLUDE" ]]; then
  echo "ENV values missing"
  exit 1
fi

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_subheader "🛠️  [3/5] Deploying production stack"

set -a
source ../.docker/.config.env.tools
# Re-sourcing the config above restores only the BASE image names, so recompute
# the tagged ones from the BUILD_TAG that start_pipeline.sh exported — otherwise
# `docker stack deploy` would substitute an empty tag.
source "$ROOT_DIR/.env.production"
set +a

export DOCKER_IMAGE_API="${DOCKER_IMAGE_API_BASE}:${BUILD_TAG}"
export DOCKER_IMAGE_WEB="${DOCKER_IMAGE_WEB_BASE}:${BUILD_TAG}"

# The api service binds ${CAIMON_KEYS_DIR} read-only for build-host SSH keys.
# A missing host dir would make Swarm create it as root-owned and empty, and the
# first Android/iOS build would fail with a confusing "no such key" — so make
# the requirement explicit here instead.
if [[ -z "${CAIMON_KEYS_DIR:-}" ]]; then
  echo "❌ CAIMON_KEYS_DIR is not set in .env.production."
  exit 1
fi
mkdir -p "$CAIMON_KEYS_DIR"

echo "🌐 Environment"
echo "  🔹 PATH=$(pwd)"
echo "  🔹 MODE=production"
echo "  🔹 BUILD_TAG=$BUILD_TAG"
echo "  🔹 DOCKER_IMAGE_API=$DOCKER_IMAGE_API"
echo "  🔹 DOCKER_IMAGE_WEB=$DOCKER_IMAGE_WEB"
echo "  🔹 COMPOSE_FILE_PATH=$COMPOSE_FILE_PATH"
echo "  🔹 STACK_NAME=$STACK_NAME"
echo "  🔹 CAIMON_KEYS_DIR=$CAIMON_KEYS_DIR"
echo "  🔹 ROOT_DIR=$ROOT_DIR"
echo "  🔹 SHARED_DIR=$SHARED_DIR"
echo "  🔹 TOOLS_DIR=$TOOLS_DIR"
new_line

echo "✅ Deploying stack..."
new_line
docker stack deploy -c "$COMPOSE_FILE_PATH" "$STACK_NAME"
new_line

echo "✅ [$STACK_NAME] stack deployed!"
new_line

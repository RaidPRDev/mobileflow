#!/bin/bash

# start_pipeline.sh
# Usage: ./start_pipeline.sh dev|prod
# Runs on the CLOUD SERVER, from inside <CLOUD_PATH><DOMAIN_PATH_PREFIX>/.docker
# after start.prod.sh has uploaded and extracted the build.

set -e

set -a
source ./.config.env.tools
set +a

if [[ -z "$SHARED_PATH"     || \
      -z "$TOOLS_PATH"      || \
      -z "$SCRIPTS_INCLUDE" ]]; then
  echo "ENV values missing"
  exit 1
fi

# Globals
export SCRIPT_PATH="$(realpath "$0")"
export SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
export ROOT_DIR="$(realpath "$SCRIPT_DIR/../")"
export SHARED_DIR="$ROOT_DIR/${SHARED_PATH}"
export TOOLS_DIR="$ROOT_DIR/${TOOLS_PATH}"
export SCRIPTS_INCLUDE="$SCRIPTS_INCLUDE"

MODE=$1

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 dev|prod"
  exit 1
fi

export MODE=$MODE

# Unique image tag per build so `docker stack deploy` actually rolls the
# api/web services — Swarm treats an unchanged image reference as "nothing to
# do" and would skip the restart. Overridable via the environment; otherwise
# stamped with the build time.
export BUILD_TAG="${BUILD_TAG:-$(date +%Y%m%d_%H%M%S)}"
export DOCKER_IMAGE_API="${DOCKER_IMAGE_API_BASE}:${BUILD_TAG}"
export DOCKER_IMAGE_WEB="${DOCKER_IMAGE_WEB_BASE}:${BUILD_TAG}"

if [[ "$MODE" == "prod" ]]; then
  export COMPOSE_FILE_PATH="${ROOT_DIR}/.docker/$DOCKER_COMPOSE_PROD"
else
  export COMPOSE_FILE_PATH="${ROOT_DIR}/.docker/$DOCKER_COMPOSE_DEV"
fi

echo "🌐 Environment"
echo "  🔹 PATH=$(pwd)"
echo "  🔹 MODE=$MODE"
echo "  🔹 BUILD_TAG=$BUILD_TAG"
echo "  🔹 DOCKER_IMAGE_API=$DOCKER_IMAGE_API"
echo "  🔹 DOCKER_IMAGE_WEB=$DOCKER_IMAGE_WEB"
echo "  🔹 DOCKER_COMPOSE=$DOCKER_COMPOSE_PROD"
echo "  🔹 COMPOSE_FILE_PATH=$COMPOSE_FILE_PATH"
echo "  🔹 STACK_NAME=$STACK_NAME"
echo "  🔹 ROOT_DIR=$ROOT_DIR"
echo "  🔹 SCRIPT_DIR=$SCRIPT_DIR"
echo "  🔹 SHARED_DIR=$SHARED_DIR"
echo "  🔹 TOOLS_DIR=$TOOLS_DIR"

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_header "Caimón Pipeline"

# Ensure scripts are executable
chmod +x "$TOOLS_DIR"/*.sh

# NOTE: no `docker stack rm` here, unlike the old crossx pipeline. Removing the
# stack would tear down Postgres on every deploy (downtime + churn) and trigger
# the Swarm network-removal race where an immediate redeploy fails with
# "network ... not found". deploy.prod.sh runs `docker stack deploy` instead,
# which rolls only the services whose spec changed — api/web get a new image
# tag, db's spec is identical so its task is left running.

# Runtime secrets for `docker stack deploy` variable substitution
# (CAIMON_DB_PASSWORD, CAIMON_COOKIE_SECRET, SUPERADMIN_*, build-host config…).
# The operator keeps these in .env.production at the repo root; start.prod.sh
# ships it with the build.
if [[ -f "$ROOT_DIR/.env.production" ]]; then
  set -a
  source "$ROOT_DIR/.env.production"
  set +a
  echo "✅ Loaded runtime secrets from .env.production"
else
  echo "❌ Missing $ROOT_DIR/.env.production — the stack file needs it for"
  echo "   CAIMON_DB_PASSWORD, CAIMON_COOKIE_SECRET and friends. Copy"
  echo "   .docker/.env.production.example locally, fill it in, and redeploy."
  exit 1
fi

# The local registry backs the image references in the stack file. It is
# single-node (images are built here and used by tag, never pushed), but the
# stack file still names localhost:5005/... so a multi-node swarm can push later.
if ! curl -sf http://localhost:5005/v2/ > /dev/null 2>&1; then
  echo "⚠️  Local registry not running on port 5005. Starting..."
  docker rm -f registry 2>/dev/null || true
  docker run -d --restart always -p 5005:5000 --name registry registry:2
  sleep 3
fi
echo "✅ Local registry is healthy"

# Both images are built with `docker build -f .docker/Dockerfile.{api,web}`, so
# unlike the old single-Dockerfile crossx flow there is nothing to relocate.

case "$MODE" in
    dev)
        # Local development runs on the host via `pnpm dev:up` (rspack dev
        # server + tsx + the Postgres container in infra/.docker/dev.yml), so
        # there is no dev image to build here.
        echo "❌ dev mode is not implemented for this stack — use pnpm dev:up locally."
        exit 1
        ;;
    prod)
        bash "$TOOLS_DIR/build.prod.sh"
        bash "$TOOLS_DIR/backup.prod.sh"
        bash "$TOOLS_DIR/deploy.prod.sh"
        bash "$TOOLS_DIR/detect.prod.sh"
        bash "$TOOLS_DIR/clean.prod.sh"
        ;;
    *)
        echo "Invalid mode: $MODE"
        exit 1
        ;;
esac

new_line
echo "🎉 Pipeline completed!"
new_line
echo " 🔹 PATH             $(pwd)"
echo " 🔹 MODE             $MODE"
echo " 🔹 STACK_NAME       $STACK_NAME"
echo " 🔹 DOMAIN_NAME      $DOMAIN_NAME"
echo " 🔹 URL_NAME         $URL_NAME"
new_line

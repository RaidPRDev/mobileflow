#!/bin/bash

# start.sh
# Usage: ./start.sh prod
#
# Entry point for a Caimón production deploy: zips this workspace, uploads it to
# the swarm host, builds both images there and rolls the `caimon` stack.
# Admin → Deploy runs this exact script, so a click and a terminal do the same
# thing.

# Only when a human is watching — Admin → Deploy captures this output into a log
# view, where a clear-screen escape sequence is noise.
[ -t 1 ] && clear

# Run from this script's own directory so ./.docker/... resolves against the
# workspace no matter where it was launched from (the API spawns it with the
# repo root as cwd, but a shell may not).
cd "$(dirname "$(realpath "$0")")" || { echo "❌ cannot cd to script dir"; exit 1; }

MODE=$1

if [[ -z "$MODE" ]]; then
    echo "Usage: $0 prod"
    exit 1
fi

echo "✅ Loading Environment File"
set -a
CONFIG_FILE="${CAIMON_DEPLOY_CONFIG_FILE:-./.docker/.config.env.tools}"
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Missing environment file: $CONFIG_FILE"
    exit 1
fi
source "$CONFIG_FILE"
set +a

# Globals consumed by .docker/.tools/*.sh
export SCRIPT_PATH="$(realpath "$0")"
export ROOT_DIR="$(dirname "$SCRIPT_PATH")"
export SHARED_DIR="$ROOT_DIR/${SHARED_PATH}"
export TOOLS_DIR="$ROOT_DIR/${TOOLS_PATH}"
export MODE="$MODE"

echo "🌐 Environment:"
echo "  🔹 SCRIPT_PATH=$SCRIPT_PATH"
echo "  🔹 ROOT_DIR=$ROOT_DIR"
echo "  🔹 SHARED_DIR=$SHARED_DIR"
echo "  🔹 TOOLS_DIR=$TOOLS_DIR"
echo "  🔹 MODE=$MODE"

case "$MODE" in
    dev)
        echo "DEV mode is not implemented — local development runs via pnpm dev:up."
        exit 1
        ;;
    prod)
        bash "${TOOLS_DIR}/start.prod.sh" "$MODE"
        ;;
    *)
        echo "Invalid mode: $MODE"
        exit 1
        ;;
esac

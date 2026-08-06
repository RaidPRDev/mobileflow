#!/bin/bash

# start.prod.sh
# Usage: bash .docker/.tools/start.prod.sh prod
# Runs on the LOCAL MACHINE (or on the API host when triggered from
# Admin → Deploy): zips the workspace, uploads it, and hands off to
# start_pipeline.sh on the cloud server.

set -e

if [[ -z "$MODE"      || \
      -z "$ROOT_DIR"  || \
      -z "$TOOLS_DIR" || \
      -z "$SHARED_DIR" ]]; then
  echo "ENV values missing [MODE, ROOT_DIR, TOOLS_DIR, SHARED_DIR]"
  echo "Run this through ./start.sh prod (or Admin → Deploy), not directly."
  exit 1
fi

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

# The config file carries a Windows-style SSH key path because it is edited on
# Windows, while this script runs under WSL/bash. Convert it, then work from a
# private copy: OpenSSH refuses a key whose permissions look world-readable, and
# anything under /mnt/d reports 0777.
if command -v wslpath >/dev/null 2>&1 && [[ "${SSH_KEY:-}" =~ ^[A-Za-z]:\\ ]]; then
  SSH_KEY="$(wslpath -u "$SSH_KEY")"
fi
if [[ -n "${SSH_KEY:-}" && -f "$SSH_KEY" ]]; then
  SECURE_KEY_DIR="${TMPDIR:-/tmp}/caimon-deploy-ssh"
  mkdir -p "$SECURE_KEY_DIR"
  chmod 700 "$SECURE_KEY_DIR" 2>/dev/null || true
  SECURE_SSH_KEY="$SECURE_KEY_DIR/$(basename "$SSH_KEY")"
  if [[ "$SSH_KEY" != "$SECURE_SSH_KEY" ]]; then
    cp "$SSH_KEY" "$SECURE_SSH_KEY"
  fi
  chmod 600 "$SECURE_SSH_KEY" 2>/dev/null || true
  SSH_KEY="$SECURE_SSH_KEY"
  export SSH_KEY
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "❌ SSH key not found: $SSH_KEY"
  echo "   Check SSH_KEY in .docker/.config.env.tools."
  exit 1
fi

set_header "$DOMAIN_NAME | Production Build"

# zip: the checked-in Windows binary when running under Git Bash, otherwise
# whatever `zip` is on PATH (WSL, Linux, macOS).
ZIP_UTIL_BASE="$(dirname "$0")/utils/zip"
SHELL_OS="$(uname -s 2>/dev/null || true)"
case "$SHELL_OS" in
  MINGW*|MSYS*|CYGWIN*) CAN_RUN_WINDOWS_EXE=1 ;;
  *) CAN_RUN_WINDOWS_EXE=0 ;;
esac

if [[ -x "$ZIP_UTIL_BASE" ]]; then
  ZIP_UTIL="$ZIP_UTIL_BASE"
elif [[ "$CAN_RUN_WINDOWS_EXE" == "1" && -f "${ZIP_UTIL_BASE}.exe" ]]; then
  ZIP_UTIL="${ZIP_UTIL_BASE}.exe"
elif command -v zip >/dev/null 2>&1; then
  ZIP_UTIL="$(command -v zip)"
else
  echo "❌ Missing zip utility. Expected $ZIP_UTIL_BASE, ${ZIP_UTIL_BASE}.exe on"
  echo "   Windows-compatible bash, or zip on PATH (apt install zip)."
  exit 1
fi

# ---------- CONFIG ----------
BUILD_DATE=$(date +"%Y%m%d_%H%M%S")
HOST_TMP_PATH="./.tmp/deploy"
BUILDER_PATH="${CLOUD_PATH}${DOMAIN_PATH_PREFIX}"
CLOUD_TMP_PATH="${CLOUD_PATH}${DOMAIN_PATH_PREFIX}/.tmp"
ZIP_NAME="build_${BUILD_DATE}.zip"
LOCAL_ZIP_PATH="${HOST_TMP_PATH}/${ZIP_NAME}"
CLOUD_ZIP_PATH="${CLOUD_TMP_PATH}/${ZIP_NAME}"

echo "🌐 Environment:"
echo "  🔹 HOST_TMP_PATH=$HOST_TMP_PATH"
echo "  🔹 CURRENT_PATH=$(pwd)"
echo "  🔹 BUILD_DATE=$BUILD_DATE"
echo "  🔹 DOCKER_IMAGE_API_BASE=$DOCKER_IMAGE_API_BASE"
echo "  🔹 DOCKER_IMAGE_WEB_BASE=$DOCKER_IMAGE_WEB_BASE"
echo "  🔹 DOCKER_COMPOSE=$DOCKER_COMPOSE_PROD"
echo "  🔹 STACK_NAME=$STACK_NAME"
echo "  🔹 CLOUD_USER=$CLOUD_USER"
echo "  🔹 CLOUD_KEY=$SSH_KEY"
echo "  🔹 CLOUD_HOST=$CLOUD_HOST"
echo "  🔹 CLOUD_PATH=$CLOUD_PATH"
echo "  🔹 CLOUD_TMP_PATH=$CLOUD_TMP_PATH"
echo "  🔹 BUILDER_PATH=$BUILDER_PATH"
echo "  🔹 LOCAL_ZIP_PATH=$LOCAL_ZIP_PATH"
echo "  🔹 CLOUD_ZIP_PATH=$CLOUD_ZIP_PATH"
echo "  🔹 SHARED_DIR=$SHARED_DIR"
echo "  🔹 TOOLS_DIR=$TOOLS_DIR"
echo "  🔹 ZIP_UTIL=$ZIP_UTIL"

new_line

# Work from the workspace root regardless of where this was launched from.
cd "$ROOT_DIR"

rm -rf "$HOST_TMP_PATH"
mkdir -p "$HOST_TMP_PATH"

if [[ ! -f ".env.production" ]]; then
  echo "❌ Missing .env.production at the workspace root."
  echo "   cp .docker/.env.production.example .env.production and fill it in —"
  echo "   the stack file substitutes those values on the cloud host."
  exit 1
fi

# ---------- STEP 1: Create ZIP ----------
new_line
echo "⚙️  [1/5] Creating ZIP: $ZIP_NAME $LOCAL_ZIP_PATH"

# Exclusions mirror .dockerignore:
#   node_modules — the images run `pnpm install --frozen-lockfile`, so shipping
#     it is pure waste (and on Windows it is a few hundred MB of materialized
#     pnpm links the docker build ignores anyway).
#   apps/desktop/src-tauri — ~900 MB of Rust build output. Only the desktop
#     app's package.json is needed, and only so pnpm can validate the workspace
#     against the lockfile.
#   infra/seed — generated admin DB dump with encrypted credentials in it.
#   apps/*/.env — the developer's LOCAL environment. Production config comes
#     from .env.production via the stack file; shipping a dev .env would put a
#     second, stale source of truth on the host (and env.ts would read it).
"${ZIP_UTIL}" -r "$LOCAL_ZIP_PATH" \
   apps packages infra assets .docker package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .env.production .dockerignore \
   -x '*/node_modules/*' '*/dist/*' '*/.tmp/*' '*/.git/*' '*/*.log' 'infra/seed/*' 'apps/desktop/src-tauri/*' 'apps/*/.env' 'apps/*/.env.local'

# ---------- STEP 2: Connect & prepare remote ----------
new_line
echo "⚙️  [2/5] Connecting to cloud and preparing remote folder..."

ssh -i "$SSH_KEY" "$CLOUD_USER@$CLOUD_HOST" "
  echo '📂 Validating [$BUILDER_PATH] folder'
  if [ ! -d \"$BUILDER_PATH\" ]; then
      mkdir -p \"$BUILDER_PATH\"
      chown -R root:root \"$BUILDER_PATH\"
      chmod 775 \"$BUILDER_PATH\"
      echo '✅ [$BUILDER_PATH] created.'
  fi

  echo '📂 Validating [$CLOUD_TMP_PATH] folder'
  if [ ! -d \"$CLOUD_TMP_PATH\" ]; then
      mkdir -p \"$CLOUD_TMP_PATH\"
      chown -R root:root \"$CLOUD_TMP_PATH\"
      chmod 775 \"$CLOUD_TMP_PATH\"
      echo '✅ [$CLOUD_TMP_PATH] created.'
  fi

  echo '🗑️  Clear [$CLOUD_TMP_PATH] folder'
  rm -f \"$CLOUD_TMP_PATH\"/*.zip
  echo '✅ [$CLOUD_TMP_PATH] cleared.'

  echo '✅ Path validation complete.'
"

# ---------- STEP 3: Upload ZIP ----------
new_line
echo "⚙️  [3/5] Uploading ZIP to cloud server..."
scp -i "$SSH_KEY" "$LOCAL_ZIP_PATH" "$CLOUD_USER@$CLOUD_HOST:$CLOUD_TMP_PATH/"
wait
echo "✅ Upload complete!"

# ---------- STEP 4: Extract and run pipeline ----------
new_line
echo "⚙️  [4/5] Extracting ZIP and running pipeline on cloud server..."
# The script below is expanded LOCALLY (double quotes) and then executed by the
# remote login shell as one string — hence `set -e` inside it, so a failed
# unzip aborts before the pipeline runs instead of building from a half-written
# directory.
ssh -i "$SSH_KEY" "$CLOUD_USER@$CLOUD_HOST" "
set -e

echo '🧹 Clear ${BUILDER_PATH} contents'
if [ -d '$BUILDER_PATH' ]; then
  rm -rf $BUILDER_PATH/.docker
  rm -rf $BUILDER_PATH/apps
  rm -rf $BUILDER_PATH/packages
  rm -rf $BUILDER_PATH/infra
  rm -rf $BUILDER_PATH/assets
  echo '✅ [${BUILDER_PATH}] cleared.'
fi

cd '${BUILDER_PATH}'

echo '📦 Extracting package to ${BUILDER_PATH}'
unzip -o $CLOUD_ZIP_PATH -d '${BUILDER_PATH}'

echo '🔑 Ensure scripts are executable'
chmod +x .docker/start_pipeline.sh
chmod +x .docker/.tools/*.sh

cd .docker
./start_pipeline.sh $MODE
"

new_line
echo "⚙️  [5/5] Done — pipeline finished on the cloud server."

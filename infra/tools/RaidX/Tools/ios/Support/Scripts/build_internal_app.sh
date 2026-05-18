#!/bin/bash
set -euo pipefail

# ================================
# INCLUDE GLOBALS
# ================================
GLOBALS_FILE="$HOME/RaidX/Tools/Support/globals.sh"
if [ -f "$GLOBALS_FILE" ]; then
  # shellcheck source=/dev/null
  source "$GLOBALS_FILE"
  echo "✅ Loaded globals from $GLOBALS_FILE"
else
  echo "❌ globals.sh not found at $GLOBALS_FILE"
  exit 1
fi

set_header "Build Internal App"

echo "📦 Building internal web app and syncing with iOS..."

# ================================
# INPUTS (from params)
# ================================
MODE="${1:-}"
CLIENT_ID="${2:-}"
BUILD_ID="${3:-}"
P12_PATH="${4:-}"
P12_PASSWORD="${5:-}"
PROVISION_ID="${6:-}"
PROVISION_NAME="${7:-}"
PROVISION_PATH="${8:-}"

if [[ -z "$MODE" || -z "$CLIENT_ID" || -z "$BUILD_ID" || -z "$P12_PATH" || -z "$P12_PASSWORD" || -z "$PROVISION_ID" || -z "$PROVISION_PATH" || -z "$PROVISION_NAME" ]]; then
  echo "❌ Missing required parameters."
  echo "Usage: $0 MODE CLIENT_ID BUILD_ID P12_PATH P12_PASSWORD PROVISION_ID PROVISION_PATH PROVISION_NAME"
  exit 1
fi

cd "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID"

echo "📂 Current directory: $(pwd)"

# ================================
# 1️⃣ Install dependencies
# ================================
echo "📥 Installing npm dependencies..."
if [ -f "package-lock.json" ]; then
  npm ci
else
  echo "⚠️ No package-lock.json found, running npm install instead..."
  npm install
fi

# ================================
# 2️⃣ Build web app
# ================================

# set Project Specific Environment
export PLATFORM="ios"
export CLARITY_ID="oztc10g5eg"

echo "🔨 Building web app..."
npm run build

# ================================
# 3️⃣ Sync with Capacitor iOS
# ================================
echo "🔄 Syncing web assets into iOS project..."
npx cap telemetry off

# Ensure the iOS app dir exists — mirrors the Android assets-dir guard.
# Empty subdirs (e.g. public/) aren't tracked by git, so a client repo may
# ship ios/App/App without public/, causing cap sync to ENOENT.
mkdir -p ios/App/App/public

# `cap sync ios` is internally `cap copy ios` + `cap update ios` — copy
# writes ios/App/App/capacitor.config.json from the root config, then update
# reads that file to refresh CocoaPods. Running `cap update` separately
# (or first) fails on a clean build because the iOS-side config hasn't
# been generated yet.
npx cap sync ios

echo "🎉 Internal app build & iOS sync completed!"

# dev_stop
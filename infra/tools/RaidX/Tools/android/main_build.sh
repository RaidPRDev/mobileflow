#!/bin/bash
set -euo pipefail

# ================================
# ANDROID BUILD ORCHESTRATOR
# Runs inside Docker container
# ================================

# Environment variables passed via Docker -e flags:
# MODE, CLIENT_ID, BUILD_ID, ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASS,
# ANDROID_ALIAS, ANDROID_ACCOUNT_ID, ANDROID_EMAIL

TOOLS_DIR="/tools"
SCRIPTS_DIR="$TOOLS_DIR/Support/Scripts"
GLOBALS_FILE="$TOOLS_DIR/Support/globals.sh"

# Source globals so downstream scripts inherit FORCE_COLOR/CLICOLOR_FORCE/TERM
# and the rich-console GRADLE_OPTS. Without this, the env exports in globals.sh
# only apply if a script sources it directly.
if [ -f "$GLOBALS_FILE" ]; then
  # shellcheck source=/dev/null
  source "$GLOBALS_FILE"
fi

echo ""
echo "==========================================="
echo " RaidX | Android Build"
echo "==========================================="
echo ""

echo "📋 Build Configuration:"
echo "  🔹 MODE=$MODE"
echo "  🔹 CLIENT_ID=$CLIENT_ID"
echo "  🔹 BUILD_ID=$BUILD_ID"

# ================================
# 1️⃣ Check Requirements
# ================================
echo ""
echo "⚙️  [1/5] Checking build requirements..."
bash "$SCRIPTS_DIR/build_requirements.sh"

# ================================
# 2️⃣ Build Internal Web App + Capacitor Sync
# ================================
echo ""
echo "⚙️  [2/5] Building internal web app..."
bash "$SCRIPTS_DIR/build_internal_app.sh"

# ================================
# 3️⃣ Build Android App (Gradle)
# ================================
echo ""
echo "⚙️  [3/5] Building Android app..."
bash "$SCRIPTS_DIR/build_android_app.sh"

# ================================
# 4️⃣ Deploy to Google Play (optional)
# ================================
echo ""
echo "⚙️  [4/5] Deploy step..."
bash "$SCRIPTS_DIR/build_deploy.sh"

# ================================
# 5️⃣ Cleanup
# ================================
echo ""
echo "⚙️  [5/5] Cleaning up..."
bash "$SCRIPTS_DIR/build_dispose.sh"

echo ""
echo "🎉 Android build pipeline complete!"

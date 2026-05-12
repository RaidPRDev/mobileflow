#!/bin/bash
# Global variables for all scripts

# Detect if running on MacOS
export IS_DARWIN=$([ -x "$(command -v sw_vers)" ] && echo true || echo false)

# Server credentials (from .env - no hardcoded fallbacks for security)
export SERVER_IP="${MAC_SERVER_IP:?MAC_SERVER_IP not set in .env}"
export SERVER_PORT="${MAC_SERVER_PORT:-22}"
export SERVER_USER="${MAC_SERVER_USER:?MAC_SERVER_USER not set in .env}"
export SERVER_PASS="${MAC_SERVER_PASS:?MAC_SERVER_PASS not set in .env}"
export KEYCHAIN_NAME="${KEYCHAIN_NAME:-build.keychain}"
export KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-password}"

# Set HOME/USER PATH based on system macOS | Win | WSL2
export USER_HOME="/Users/$SERVER_USER"
export RAIDX_PATH="$USER_HOME/RaidX"
export RAIDX_CLIENTS_PATH="$RAIDX_PATH/Clients"
export RAIDX_TOOLS_PATH="$RAIDX_PATH/Tools"
export RAIDX_SUPPORT_PATH="$RAIDX_PATH/Tools/Support"
export RAIDX_SCRIPTS_PATH="$RAIDX_PATH/Tools/Support/Scripts"
export KEYCHAIN_PATH="$USER_HOME/Library/Keychains/$KEYCHAIN_NAME-db"
export PROVISION_FOLDER="$USER_HOME/Library/MobileDevice/Provisioning Profiles"

export APP_SCHEME="App"
export APP_WORKSPACE_NAME="App/App.xcworkspace"
export APP_XCODEPRJ_NAME="App/App.xcodeproj"
export APP_XCARCHIVE_NAME="App.xcarchive"
export APP_PODFILE_NAME="Podfile"
export APP_IPA_NAME="App.ipa"
export PODS_TARGET="Pods-App"
export PODS_WORKSPACE_NAME="Pods/Pods.xcodeproj"
export BUILD_DIR="./build"
export ARCHIVE_PATH="$BUILD_DIR/$APP_XCARCHIVE_NAME"
export EXPORT_PATH="$BUILD_DIR/ipa"
export IOS_BUILD_PATH="ios/build/ipa"
export IOS_CONFIGURATION="Release"

# echo "📢 Globals:"
# echo "🔹 RAIDX_PATH=$RAIDX_PATH"
# echo "🔹 RAIDX_CLIENTS_PATH=$RAIDX_CLIENTS_PATH"
# echo "🔹 RAIDX_TOOLS_PATH=$RAIDX_TOOLS_PATH"
# echo "🔹 RAIDX_SUPPORT_PATH=$RAIDX_SUPPORT_PATH"
# echo "🔹 RAIDX_SCRIPTS_PATH=$RAIDX_SCRIPTS_PATH"
# echo "🔹 KEYCHAIN_NAME=$KEYCHAIN_NAME"
# echo "🔹 KEYCHAIN_PATH=$KEYCHAIN_PATH"
# echo "🔹 PROVISION_FOLDER=$PROVISION_FOLDER"

if [[ "$IS_DARWIN" = "true" ]]; then
  # Load RaidX Remote Paths
  source "$RAIDX_SUPPORT_PATH/includes.sh"
else
  # Load RaidX Local Paths (relative to this script's location)
  GLOBALS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  RAID_X_SCRIPTS="$GLOBALS_SCRIPT_DIR/Scripts"
  source "$RAID_X_SCRIPTS/utils/general.sh"
  source "$RAID_X_SCRIPTS/utils/timers.sh"
  source "$RAID_X_SCRIPTS/utils/visual_loaders.sh"
fi
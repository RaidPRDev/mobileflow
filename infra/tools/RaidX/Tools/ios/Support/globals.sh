#!/bin/bash
# Global variables for all scripts

# Detect if running on MacOS
export IS_DARWIN=$([ -x "$(command -v sw_vers)" ] && echo true || echo false)

# Force ANSI color output even though the SSH session has no PTY. Tools that
# look at isatty(stdout) — clang, pod, brew, npm, etc. — honor these and emit
# escape codes that the MobileFlow web UI parses. xcodebuild itself does NOT
# honor FORCE_COLOR; if we want richer iOS color we'll wrap with xcbeautify
# later, but the regex highlighter on the frontend already paints timestamps,
# levels, paths, and SUCCEEDED/FAILED markers from the raw output.
export FORCE_COLOR=1
export CLICOLOR_FORCE=1
export TERM=xterm-256color

# Non-interactive SSH sessions don't always inherit the brew prefix in PATH,
# so xcbeautify (/opt/homebrew/bin/xcbeautify on Apple Silicon) becomes "command
# not found" inside our build pipe. Prepend the brew bin dir defensively.
if [ -d "/opt/homebrew/bin" ] && [[ ":$PATH:" != *":/opt/homebrew/bin:"* ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi

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

# Emit a phase signal that the MobileFlow worker parses from the log stream.
# Format:   [MFPHASE] <name> <status>          (e.g. [MFPHASE] building running)
# Statuses: running, success, failed, skipped
# The marker also doubles as a visible log line so a human reading the raw log
# can still see the phase transitions.
mf_phase() {
  echo "[MFPHASE] $1 $2"
}

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
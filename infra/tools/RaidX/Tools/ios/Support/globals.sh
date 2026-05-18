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
# DEPRECATED: a single shared "build.keychain" used to be the default here,
# but it caused concurrent builds on the same Mac to clobber each other's
# certs. Per-build keychains are now derived by set_build_keychain() (below)
# from BUILD_ID. We leave KEYCHAIN_NAME/KEYCHAIN_PATH unset at source time so
# any script that forgets to call set_build_keychain fails loudly instead of
# silently sharing the legacy default.
export KEYCHAIN_NAME=""
export KEYCHAIN_PATH=""
export KEYCHAIN_PASSWORD=""

# Set HOME/USER PATH based on system macOS | Win | WSL2
export USER_HOME="/Users/$SERVER_USER"
export RAIDX_PATH="$USER_HOME/RaidX"
export RAIDX_CLIENTS_PATH="$RAIDX_PATH/Clients"
export RAIDX_TOOLS_PATH="$RAIDX_PATH/Tools"
export RAIDX_SUPPORT_PATH="$RAIDX_PATH/Tools/Support"
export RAIDX_SCRIPTS_PATH="$RAIDX_PATH/Tools/Support/Scripts"
export PROVISION_FOLDER="$USER_HOME/Library/MobileDevice/Provisioning Profiles"

# Per-build keychain isolation. Call this from any script that needs to read
# or write to the build's keychain, AFTER you have BUILD_ID. Concurrent builds
# get distinct keychain files (raidx-<BUILD_ID>.keychain-db) so cert imports,
# unlocks and deletes are scoped to one build at a time.
#
# Usage:
#   set_build_keychain "$BUILD_ID"                 # generate a fresh password
#   set_build_keychain "$BUILD_ID" "$EXISTING_PW"  # use an existing password
#                                                  # (when a later script in
#                                                  # the same build needs to
#                                                  # unlock the keychain again)
set_build_keychain() {
  local bid="$1"
  local existing_pw="${2:-}"
  if [[ -z "$bid" ]]; then
    echo "❌ set_build_keychain: BUILD_ID is empty" >&2
    return 1
  fi
  export KEYCHAIN_NAME="raidx-${bid}.keychain"
  export KEYCHAIN_PATH="$USER_HOME/Library/Keychains/${KEYCHAIN_NAME}-db"
  if [[ -n "$existing_pw" ]]; then
    export KEYCHAIN_PASSWORD="$existing_pw"
  else
    # 24-char URL-safe random password; regenerated per build so a leaked
    # password from one build can't unlock another.
    KEYCHAIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    export KEYCHAIN_PASSWORD
  fi
}

# `security list-keychains -d user -s ...` REPLACES the search list, so two
# concurrent builds doing add/remove around it can drop each other's entries
# (read-modify-write race). Wrap any list-keychains -s in
# with_keychain_search_lock to serialise.
#
# Usage:
#   with_keychain_search_lock list-keychains -d user -s "$NAME" $EXISTING
#
# macOS has no flock(1); we use mkdir as the atomic lock primitive. Holds at
# most ~30s before giving up (and continuing anyway, with a warning — better
# a missed lock than a stuck build).
with_keychain_search_lock() {
  local lock_dir="/tmp/raidx-keychain.lock"
  local tries=30
  while [ $tries -gt 0 ]; do
    if mkdir "$lock_dir" 2>/dev/null; then
      # Best-effort release on any exit from this subshell — including
      # signals or `set -e` errors from the wrapped command.
      trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
      security "$@"
      local rc=$?
      rmdir "$lock_dir" 2>/dev/null || true
      trap - EXIT
      return $rc
    fi
    sleep 1
    tries=$((tries - 1))
  done
  echo "⚠️  Timed out waiting for keychain search-list lock; proceeding (may race with concurrent build)" >&2
  security "$@"
}

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
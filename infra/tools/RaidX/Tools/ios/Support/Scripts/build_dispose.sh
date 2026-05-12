#!/bin/bash
set -euo pipefail

# ===========================================
# macOS Cache Cleaner Script
# This script removes common cache, log, and
# temporary files to free up disk space.
# ===========================================

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

set_header "Build Dispose"

echo "🗑️  Removing build cache files"

# ================================
# INPUTS (from params)
# ================================
MODE="${1:-}"
CLIENT_ID="${2:-}"
BUILD_ID="${3:-}"

if [[ -z "$MODE" || -z "$CLIENT_ID" || -z "$BUILD_ID" ]]; then
  echo "❌ Missing required parameters."
  echo "Usage: $0 MODE CLIENT_ID BUILD_ID"
  exit 1
fi

if [[ "$MODE" == "dev" ]]; then
  echo "🔹 CLIENT_ID=$CLIENT_ID"
  echo "🔹 BUILD_ID=$BUILD_ID"
  echo "🔹 KEYCHAIN_NAME=$KEYCHAIN_NAME"
  echo "🔹 KEYCHAIN_PATH=$KEYCHAIN_PATH"
  echo "🔹 RAIDX_CLIENTS_PATH=$RAIDX_CLIENTS_PATH"
fi

# Apple Keychain
echo "🗑️  Remove Keychain: $KEYCHAIN_NAME | Path: $KEYCHAIN_PATH"
if [ -f "$KEYCHAIN_PATH" ]; then
  echo "📢 Deleting existing keychain: $KEYCHAIN_PATH"
  
  # deduplicate your user keychains and keep only valid .keychain-db files
  security list-keychains -d user | tr -d ' "' | grep '\.keychain-db$' | sort -u | xargs security list-keychains -d user -s

  # remove keychain
  security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
  
  echo "✅ $KEYCHAIN_NAME has been deleted."
fi


# # App node_modules
# if [ -d "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/node_modules" ]; then
#     /bin/rm -rf "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/node_modules/"* &>/dev/null
#     echo "✅ node_modules cleaned."
# fi

# --- 1. CLEAN XCODE AND iOS SIMULATOR CACHES ---
echo "▶️  Cleaning Xcode Derived Data and Archives..."
if [ -d "$HOME/Library/Developer/Xcode/DerivedData" ]; then
    /bin/rm -rf "Library/Developer/Xcode/DerivedData/"* &>/dev/null
    echo "✅ Xcode DerivedData has been removed."
fi

if [ -d "$HOME/Library/Developer/Xcode/Archives" ]; then
    /bin/rm -rf "$HOME/Library/Developer/Xcode/Archives/"* &>/dev/null
    echo "✅ Xcode Archives have been removed."
fi

echo "▶️  Cleaning iOS Simulator cache..."
if command -v xcrun &>/dev/null; then
    xcrun simctl erase all
    echo "✅ iOS Simulators have been reset."
else
    echo "⚠️ xcrun not found. Skipping simulator cleanup."
fi

# --- 2. CLEAN HOMEBREW, NPM, AND RUBY CACHES ---
echo "▶️  Cleaning Homebrew caches..."
if command -v brew &>/dev/null; then
    brew cleanup
    echo "✅ Homebrew cache cleaned."
fi

echo "▶️  Cleaning Node System caches..."
if command -v npm &>/dev/null; then
    npm cache clean --force
    echo "✅ Node System cache cleaned."
fi

echo "▶️  Cleaning Node User caches..."
if [ -d "$HOME/.npm" ]; then
    /bin/rm -rf "$HOME/.npm/"* &>/dev/null
    echo "✅ .npm User cache cleaned."
fi

# Check for .local/share, .rbenv, .npm, .gem, and .cocoapods caches
echo "▶️  Cleaning other development-related caches..."
if [ -d "$HOME/.local/share/gem" ]; then
    /bin/rm -rf "$HOME/.local/share/gem/"* &>/dev/null
    echo "✅ .local/share/gem cleaned."
fi

if [ -d "$HOME/.gem" ]; then
    /bin/rm -rf "$HOME/.gem/"* &>/dev/null
    echo "✅ .gem User cache cleaned."
fi

# if [ -d "$HOME/.cocoapods" ]; then
#     /bin/rm -rf "$HOME/.cocoapods/repos/trunk/"* &>/dev/null
#     echo "✅ CocoaPods cache cleaned (master repo)."
# fi

# --- 3. CLEAN GENERAL USER AND SYSTEM CACHES ---
echo "▶️  Cleaning user and system caches..."
# User Caches
if [ -d "$HOME/Library/Caches" ]; then
    du -sh "$HOME/Library/Caches/"
    /bin/rm -rf "$HOME/Library/Caches/"* &>/dev/null
    echo "✅ User caches cleaned."
fi

# User Logs
if [ -d "$HOME/Library/Logs" ]; then
    du -sh "$HOME/Library/Logs/"
    /bin/rm -rf "$HOME/Library/Logs/"* &>/dev/null
    echo "✅ User logs cleaned."
fi

# Crash Reports
if [ -d "$HOME/Library/Application Support/CrashReporter" ]; then
    du -sh "$HOME/Library/Application Support/CrashReporter/"
    /bin/rm -rf "$HOME/Library/Application Support/CrashReporter/"* &>/dev/null
    echo "✅ Crash reports cleaned."
fi

# System Caches (requires sudo)
# if [ -d "/Library/Caches" ]; then
#     sudo rm -rf "/Library/Caches/*"
#     echo "✅ System caches cleaned."
# fi

# CoreSimulator Caches
if [ -d "$HOME/Library/Developer/CoreSimulator" ]; then
    du -sh "$HOME/Library/Developer/CoreSimulator/"
    /bin/rm -rf "$HOME/Library/Developer/CoreSimulator/"* &>/dev/null
    echo "✅ CoreSimulator caches cleaned."
fi




# System Logs (requires sudo)
# if [ -d "/Library/Logs" ]; then
#     sudo rm -rf "/Library/Logs/*"
#     echo "✅ System logs cleaned."
# fi

# --- 4. FIND LARGE FILES IN A GIVEN DIRECTORY ---
# This function finds all files and subdirectories over a specified size
# in a given directory and its subdirectories.
# Usage: find_large_files_in_dir <directory_path>
# Example: find_large_files_in_dir "$HOME/Downloads"
find_large_files_in_dir() {
    # Check if a directory path was provided
    if [ -z "$1" ]; then
        echo "❌ Error: No directory path provided."
        echo "Usage: find_large_files_in_dir <directory_path>"
        return 1
    fi

    local target_dir="$1"

    # Check if the directory exists
    if [ ! -d "$target_dir" ]; then
        echo "❌ Error: Directory not found at '$target_dir'."
        return 1
    fi

    echo "🔍 Searching for files > 100MB in '$target_dir'..."
    # The 'find' command locates files, and '-exec du -h' shows their human-readable size.
    # The 'sort -h' command then sorts the results by size.
    find "$target_dir" -type f -size +100M -exec du -h {} \; | sort -h
    
    echo "✅ Search complete."
}

# du -sh "$HOME/Library/Containers"

# find_large_files_in_dir "$HOME/Library/Containers"

echo "==========================================="
echo "✅ Cleanup complete!"
echo "==========================================="
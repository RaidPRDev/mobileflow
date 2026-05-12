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

set_header "Build Required Libs"

echo "🔍 Checking build environment and library requirements..."


# ================================
# 1️⃣ Check Xcode CLI tools
# ================================
if ! xcode-select -p >/dev/null 2>&1; then
  echo "❌ Xcode CLI tools not found."
  echo "Install with: xcode-select --install"
else
  echo "✅ Xcode CLI tools found: $(xcode-select -p)"
fi

if command -v xcpretty >/dev/null 2>&1; then
  echo "✅ xcpretty found: $(xcpretty --version)"
else
  echo "❌ xcpretty not found in PATH. Make sure it is installed as a Ruby gem."
  exit 1
fi

# ================================
# 4️⃣ Check Ruby / rbenv
# ================================
if ! command -v ruby >/dev/null 2>&1; then
  echo "❌ Ruby not found."
else
  echo "✅ Ruby version: $(ruby -v)"
fi

if ! command -v rbenv >/dev/null 2>&1; then
  echo "⚠️ rbenv not found (optional, recommended for managing Ruby)"
  echo "Install with Homebrew: brew install rbenv ruby-build"
else
  echo "✅ rbenv found: $(rbenv -v)"
fi


# ================================
# 2️⃣ Check Node.js & npm
# ================================
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found."
  echo "Install with Homebrew: brew install node"
else
  echo "✅ Node.js version: $(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm not found."
  echo "Install Node.js to get npm"
else
  echo "✅ npm version: $(npm -v)"
fi

# ================================
# 3️⃣ Check CocoaPods
# ================================
if ! command -v pod >/dev/null 2>&1; then
  echo "❌ CocoaPods not found."
  echo "Install with: sudo gem install cocoapods OR brew install cocoapods"
else
  echo "✅ CocoaPods version: $(pod --version)"
fi

# ================================
# 5️⃣ Check Git
# ================================
if ! command -v git >/dev/null 2>&1; then
  echo "❌ Git not found."
  echo "Install with Homebrew: brew install git"
else
  echo "✅ Git version: $(git --version)"
fi

echo "🎉 All requirements checked."

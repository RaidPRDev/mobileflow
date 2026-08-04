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

# Anything the later steps actually shell out to is a hard requirement — a
# missing one is reported here, all at once, instead of blowing up halfway
# through `npm ci` or an xcodebuild pipe with a cryptic error. Collected as a
# newline-delimited string rather than an array: /bin/bash on macOS is 3.2,
# where expanding an empty array under `set -u` is itself an error.
MISSING=""

# check_tool <command> <label> <version command> <install hint>
check_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "✅ $2 found: $(eval "$3" 2>/dev/null | head -n1)"
  else
    echo "❌ $2 not found in PATH."
    MISSING="${MISSING}  • ${2} — ${4}"$'\n'
  fi
}

# ================================
# 1️⃣ Xcode CLI tools
# ================================
if ! xcode-select -p >/dev/null 2>&1; then
  echo "❌ Xcode CLI tools not found."
  MISSING="${MISSING}  • Xcode CLI tools — xcode-select --install"$'\n'
else
  echo "✅ Xcode CLI tools found: $(xcode-select -p)"
fi

# ================================
# 2️⃣ Node.js & npm — build_internal_app.sh runs `npm ci` + `npm run build`
# ================================
check_tool node "Node.js" "node -v" "brew install node"
check_tool npm "npm" "npm -v" "comes with Node.js (brew install node)"

# ================================
# 3️⃣ CocoaPods — build_update_podfile.sh / the Pods workspace
# ================================
check_tool pod "CocoaPods" "pod --version" "brew install cocoapods (or gem install cocoapods)"

# ================================
# 4️⃣ xcbeautify — every xcodebuild invocation is piped through it, so a
#     missing binary breaks the build pipe, not just the log formatting.
# ================================
check_tool xcbeautify "xcbeautify" "xcbeautify --version" "brew install xcbeautify"

# ================================
# 5️⃣ Git — the worker clones before we run, but build steps shell out too
# ================================
check_tool git "Git" "git --version" "brew install git"

# ================================
# 6️⃣ Ruby / rbenv — informational. CocoaPods brings its own Ruby needs; we
#     only report what's here to make PATH problems obvious in the log.
# ================================
if command -v ruby >/dev/null 2>&1; then
  echo "ℹ️  Ruby version: $(ruby -v)"
else
  echo "ℹ️  Ruby not found."
fi
if command -v rbenv >/dev/null 2>&1; then
  echo "ℹ️  rbenv found: $(rbenv -v)"
else
  echo "ℹ️  rbenv not found (optional — brew install rbenv ruby-build)"
fi

if [ -n "$MISSING" ]; then
  echo ""
  echo "❌ Build host is missing required tooling:"
  printf '%s' "$MISSING"
  echo ""
  echo "PATH seen by this build: $PATH"
  echo ""
  echo "Install the tools above on the build Mac, or run:"
  echo "  bash \$HOME/RaidX/Tools/Support/Scripts/install_requirements.sh"
  echo ""
  echo "If they ARE installed and you can run them in your own terminal, the"
  echo "build's non-login PATH can't see them — Homebrew's shellenv usually"
  echo "lives in ~/.zprofile, which the build's bash login shell never reads."
  exit 1
fi

echo "🎉 All requirements checked."

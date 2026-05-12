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

set_header "Install Dependencies"

echo "🔧 Installing build environment requirements..."


# ================================
# 0️⃣ Helper: ensure Homebrew is installed
# ================================
if ! command -v brew >/dev/null 2>&1; then
  echo "🍺 Homebrew not found. Installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  echo "✅ Homebrew found: $(brew --version | head -n1)"
fi


# ================================
# 1️⃣ Xcode CLI Tools
# ================================
if ! xcode-select -p >/dev/null 2>&1; then
  echo "❌ Xcode CLI tools not found. Installing..."
  xcode-select --install
else
  echo "✅ Xcode CLI tools found: $(xcode-select -p)"
fi


# ================================
# 2️⃣ Git
# ================================
if ! command -v git >/dev/null 2>&1; then
  echo "❌ Git not found. Installing..."
  brew install git
else
  echo "✅ Git version: $(git --version)"
fi


# ================================
# 3️⃣ Node.js & npm
# ================================
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found. Installing..."
  brew install node
else
  echo "✅ Node.js version: $(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm not found. Node.js installation might have failed."
else
  echo "✅ npm version: $(npm -v)"
fi


# ================================
# 4️⃣ rbenv & Ruby
# ================================
if ! command -v rbenv >/dev/null 2>&1; then
  echo "⚠️ rbenv not found. Installing..."
  brew install rbenv ruby-build
else
  echo "✅ rbenv found: $(rbenv -v)"
fi

# Load rbenv for this script
if command -v rbenv >/dev/null 2>&1; then
  eval "$(rbenv init -)"
fi

# Install Ruby ≥ 3.2 if missing
REQUIRED_RUBY_VERSION="3.2.2"
if ! ruby -v | grep -q "3.2"; then
  echo "⚠️ Installing Ruby $REQUIRED_RUBY_VERSION via rbenv..."
  rbenv install -s "$REQUIRED_RUBY_VERSION"
  rbenv global "$REQUIRED_RUBY_VERSION"
fi
echo "✅ Ruby version: $(ruby -v)"


# ================================
# 5️⃣ CocoaPods
# ================================
if ! command -v pod >/dev/null 2>&1; then
  echo "❌ CocoaPods not found. Installing..."
  gem install cocoapods
else
  echo "✅ CocoaPods version: $(pod --version)"
fi


# ================================
# 6️⃣ UTF-8 environment fix
# ================================
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

echo "🎉 All requirements installed and configured!"

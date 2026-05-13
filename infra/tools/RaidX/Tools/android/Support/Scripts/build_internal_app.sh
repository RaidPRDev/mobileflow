#!/bin/bash
set -euo pipefail

echo "📦 Building internal web app and syncing with Android..."

cd /workspace

# 1. Install dependencies
echo "📥 Installing npm dependencies..."
if [ -f "package-lock.json" ]; then
  npm ci
else
  echo "⚠️  No package-lock.json found, running npm install..."
  npm install
fi

# 2. Build web app
export PLATFORM="android"

echo "🔨 Building web app..."
npm run build

# 3. Sync with Capacitor Android
echo "🔄 Syncing web assets into Android project..."
npx cap telemetry off

# Add Android platform if not already present
if [ ! -d "android" ]; then
  echo "📱 Adding Android platform..."
  npx cap add android
fi

# Ensure the assets dir exists — git doesn't track empty dirs, so a client repo
# may ship an android/ folder without app/src/main/assets/, which makes
# cap update fail with ENOENT on capacitor.plugins.json.
mkdir -p android/app/src/main/assets

npx cap update android
npx cap sync android

echo "✅ Internal app build and Android sync completed!"

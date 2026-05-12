#!/bin/bash
set -euo pipefail

echo "🔍 Checking Android build environment..."

ERRORS=0

# Check Java
if ! command -v java >/dev/null 2>&1; then
  echo "❌ Java not found"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ Java: $(java -version 2>&1 | head -n1)"
fi

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ Node.js: $(node -v)"
fi

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm not found"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ npm: $(npm -v)"
fi

# Check Android SDK
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "❌ ANDROID_HOME not set"
  ERRORS=$((ERRORS + 1))
else
  echo "✅ ANDROID_HOME: $ANDROID_HOME"
fi

# Check Gradle wrapper in project
if [ -f "/workspace/android/gradlew" ]; then
  echo "✅ Gradle wrapper found"
else
  echo "⚠️  gradlew not found in /workspace/android/ - will use system Gradle"
fi

# Check keystore
if [ -n "${ANDROID_KEYSTORE:-}" ] && [ -f "$ANDROID_KEYSTORE" ]; then
  echo "✅ Android keystore found: $ANDROID_KEYSTORE"
elif [ -n "${ANDROID_KEYSTORE:-}" ]; then
  echo "⚠️  Android keystore not found at: $ANDROID_KEYSTORE"
else
  echo "⚠️  ANDROID_KEYSTORE not set"
fi

if [ $ERRORS -gt 0 ]; then
  echo "❌ $ERRORS requirement(s) missing. Aborting."
  exit 1
fi

echo "✅ All Android requirements checked"

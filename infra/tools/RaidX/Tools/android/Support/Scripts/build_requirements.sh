#!/bin/bash
set -euo pipefail

echo "🔍 Checking Android build environment..."

ERRORS=0

# Capacitor 7 compiles its android library at source release 21, so an older
# JDK dies deep inside `compileReleaseJavaWithJavac` minutes into the build
# with "invalid source release: 21". Catch it here instead. Override for a
# project pinned to an older toolchain: ANDROID_MIN_JAVA=17.
MIN_JAVA="${ANDROID_MIN_JAVA:-21}"

# Check Java
if ! command -v java >/dev/null 2>&1; then
  echo "❌ Java not found"
  ERRORS=$((ERRORS + 1))
else
  JAVA_VERSION_LINE="$(java -version 2>&1 | head -n1)"
  # "openjdk version \"21.0.11\"" → 21;  bare "24" → 24;  legacy "1.8.0_402" → 8
  JAVA_MAJOR="$(printf '%s' "$JAVA_VERSION_LINE" | sed -nE 's/.*version "([0-9]+)(\.([0-9]+))?.*/\1 \3/p' | awk '{ print ($1 == 1 ? $2 : $1) }')"
  if [ -z "$JAVA_MAJOR" ]; then
    echo "⚠️  Java: $JAVA_VERSION_LINE (could not parse major version — continuing)"
  elif [ "$JAVA_MAJOR" -lt "$MIN_JAVA" ]; then
    echo "❌ Java $JAVA_MAJOR is too old — this build needs Java $MIN_JAVA or newer"
    echo "   Found: $JAVA_VERSION_LINE ($(command -v java))"
    echo "   Capacitor 7 compiles at source release 21. Rebuild the Android"
    echo "   builder image (Dockerfile installs openjdk-21-jdk):"
    echo "     docker build -t raidx-android-builder:latest \$LINUX_BUILD_ANDROID_TOOLS"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Java: $JAVA_VERSION_LINE"
  fi
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

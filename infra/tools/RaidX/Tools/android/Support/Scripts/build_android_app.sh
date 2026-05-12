#!/bin/bash
set -euo pipefail

echo "🔨 Building Android application..."

ANDROID_DIR="/workspace/android"

if [ ! -d "$ANDROID_DIR" ]; then
  echo "❌ Android project not found at $ANDROID_DIR"
  exit 1
fi

cd "$ANDROID_DIR"

# Determine Gradle command
if [ -f "gradlew" ]; then
  chmod +x gradlew
  GRADLE_CMD="./gradlew"
else
  GRADLE_CMD="gradle"
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
$GRADLE_CMD clean

# Build signed release
if [ -n "${ANDROID_KEYSTORE:-}" ] && [ -f "$ANDROID_KEYSTORE" ]; then
  echo "🔐 Building signed release AAB..."

  $GRADLE_CMD bundleRelease \
    -Pandroid.injected.signing.store.file="$ANDROID_KEYSTORE" \
    -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASS" \
    -Pandroid.injected.signing.key.alias="$ANDROID_ALIAS" \
    -Pandroid.injected.signing.key.password="$ANDROID_KEYSTORE_PASS"

  echo "🔐 Building signed release APK..."

  $GRADLE_CMD assembleRelease \
    -Pandroid.injected.signing.store.file="$ANDROID_KEYSTORE" \
    -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASS" \
    -Pandroid.injected.signing.key.alias="$ANDROID_ALIAS" \
    -Pandroid.injected.signing.key.password="$ANDROID_KEYSTORE_PASS"
else
  echo "⚠️  No keystore configured. Building unsigned release..."
  $GRADLE_CMD assembleRelease
fi

# Verify output
AAB_FILE="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
APK_FILE="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

if [ -f "$AAB_FILE" ]; then
  echo "✅ AAB built: $AAB_FILE ($(du -h "$AAB_FILE" | cut -f1))"
fi

if [ -f "$APK_FILE" ]; then
  echo "✅ APK built: $APK_FILE ($(du -h "$APK_FILE" | cut -f1))"
fi

echo "✅ Android build completed!"

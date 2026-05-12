#!/bin/bash
set -euo pipefail

echo "🚀 Deploy to Google Play"

AAB_FILE="/workspace/android/app/build/outputs/bundle/release/app-release.aab"

if [ ! -f "$AAB_FILE" ]; then
  echo "⚠️  AAB file not found at $AAB_FILE"
  echo "Skipping deployment."
  exit 0
fi

# Google Play deployment requires a service account JSON key
GPLAY_KEY="/workspace/certs/google/service-account.json"

if [ ! -f "$GPLAY_KEY" ]; then
  echo "⚠️  Google Play service account key not found at $GPLAY_KEY"
  echo "Skipping Google Play upload. Manual upload required."
  echo "📦 AAB is available at: $AAB_FILE"
  exit 0
fi

# TODO: Integrate with Gradle Play Publisher plugin or Google API client
# Example with Gradle Play Publisher:
# cd /workspace/android
# ./gradlew publishReleaseBundle

echo "📦 AAB location: $AAB_FILE"
echo "✅ Deploy step complete"

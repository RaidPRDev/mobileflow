#!/bin/bash
set -euo pipefail

echo "🧹 Cleaning up Android build files..."

# Clean Gradle project cache
if [ -d "/workspace/android/.gradle" ]; then
  rm -rf /workspace/android/.gradle
  echo "✅ Gradle project cache cleaned"
fi

# Clean node_modules
if [ -d "/workspace/node_modules" ]; then
  rm -rf /workspace/node_modules
  echo "✅ node_modules cleaned"
fi

# Clean build intermediates (keep outputs for artifact retrieval)
if [ -d "/workspace/android/app/build/intermediates" ]; then
  rm -rf /workspace/android/app/build/intermediates
  echo "✅ Build intermediates cleaned"
fi

echo "✅ Cleanup complete!"

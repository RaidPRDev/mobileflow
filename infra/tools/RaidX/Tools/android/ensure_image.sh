#!/bin/bash
set -euo pipefail

# Idempotent Docker image bootstrap for the Android build host.
#
# Run automatically at the end of `pnpm deploy:build-scripts:android` (skip
# with --no-requirements), and safe to run by hand at any time:
#
#   bash /root/RaidX/Tools/android/ensure_image.sh
#   bash /root/RaidX/Tools/android/ensure_image.sh --check
#   bash /root/RaidX/Tools/android/ensure_image.sh --force
#
# Deploying a changed Dockerfile does nothing on its own — the builds keep
# using whatever image was last tagged. So we stamp the Dockerfile's sha256
# onto the image as a label at build time and rebuild only when the deployed
# Dockerfile no longer matches that stamp. Unchanged Dockerfile → no-op, which
# matters because a cold build pulls the whole Android SDK.
#
# Usage: ensure_image.sh [--check|--force] [image-tag]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE="$SCRIPT_DIR/Dockerfile"
LABEL_KEY="raidx.dockerfile.sha"

MODE="ensure"
IMAGE=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --force) MODE="force" ;;
    -*) echo "❌ unknown flag: $arg" >&2; exit 2 ;;
    *) IMAGE="$arg" ;;
  esac
done
IMAGE="${IMAGE:-${LINUX_BUILD_ANDROID_IMAGE:-raidx-android-builder:latest}}"

echo "==========================================="
echo " 🐳 RaidX | Ensure Android Builder Image"
echo "==========================================="
echo "🔹 image      : $IMAGE"
echo "🔹 dockerfile : $DOCKERFILE"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker not found on this host — cannot build $IMAGE"
  exit 1
fi
if [ ! -f "$DOCKERFILE" ]; then
  echo "❌ Dockerfile not found at $DOCKERFILE"
  exit 1
fi

WANT_SHA="$(sha256sum "$DOCKERFILE" | cut -d' ' -f1)"
HAVE_SHA="$(docker image inspect -f "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$IMAGE" 2>/dev/null || true)"
# A label the image doesn't carry inspects as the literal "<no value>".
if [ "$HAVE_SHA" = "<no value>" ]; then HAVE_SHA=""; fi

# Cheap metadata only — the common case is "nothing to do", and starting a
# container just to print a version would make a no-op cost a container run.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  IMAGE_EXISTS="true"
  echo "🔹 present    : yes (built $(docker image inspect -f '{{ .Created }}' "$IMAGE" 2>/dev/null | cut -c1-19))"
else
  IMAGE_EXISTS="false"
  echo "🔹 present    : no"
fi

REASON=""
if [ "$MODE" = "force" ]; then
  REASON="--force requested"
elif [ "$IMAGE_EXISTS" != "true" ]; then
  REASON="image not present on this host"
elif [ -z "$HAVE_SHA" ]; then
  # Built before this script existed, so we can't prove it matches. Rebuild
  # once to get it stamped; every run after that is a no-op.
  REASON="image has no $LABEL_KEY stamp (built before this check existed)"
elif [ "$HAVE_SHA" != "$WANT_SHA" ]; then
  REASON="Dockerfile changed (${HAVE_SHA:0:12} → ${WANT_SHA:0:12})"
fi

if [ -z "$REASON" ]; then
  echo "✅ up to date (Dockerfile sha ${WANT_SHA:0:12}) — nothing to do"
  exit 0
fi

echo "🔧 rebuild needed: $REASON"

if [ "$MODE" = "check" ]; then
  echo "ℹ️  --check: would run docker build -t $IMAGE $SCRIPT_DIR"
  exit 0
fi

echo "📦 Building $IMAGE (cold builds pull the Android SDK — this takes a few minutes)..."
docker build \
  -t "$IMAGE" \
  --label "$LABEL_KEY=$WANT_SHA" \
  -f "$DOCKERFILE" \
  "$SCRIPT_DIR"

echo ""
echo "🔁 Verifying image..."
echo "✅ java: $(docker run --rm --entrypoint java "$IMAGE" -version 2>&1 | head -n1)"
echo "✅ node: $(docker run --rm --entrypoint node "$IMAGE" -v 2>&1 | head -n1)"
STAMPED="$(docker image inspect -f "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$IMAGE" 2>/dev/null || true)"
if [ "$STAMPED" != "$WANT_SHA" ]; then
  echo "❌ image built but the $LABEL_KEY stamp didn't stick (got '$STAMPED')"
  exit 1
fi
echo "🎉 $IMAGE ready (Dockerfile sha ${WANT_SHA:0:12})"

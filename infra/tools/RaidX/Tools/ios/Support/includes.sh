#!/bin/bash

# RaidX Scripts
source "$RAIDX_SCRIPTS_PATH/utils/timers.sh"
source "$RAIDX_SCRIPTS_PATH/utils/visual_loaders.sh"
source "$RAIDX_SCRIPTS_PATH/utils/general.sh"

# --- CocoaPods bootstrap for SSH ---
# Add Homebrew and Ruby gem paths
export PATH="$HOME/.rbenv/shims:$HOME/.gem/ruby/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Initialize rbenv again to ensure shims are active
if command -v rbenv >/dev/null 2>&1; then
  eval "$(rbenv init - bash)"
fi


check_requirements() {

  echo "check_requirements() $PROVISION_FOLDER"

  # ================================
  # 1️⃣ Check Build Requirements
  # ================================
  BUILD_REQUIRE_CMD="${RAIDX_SCRIPTS_PATH}/build_requirements.sh"

  if [[ ! -x "$BUILD_REQUIRE_CMD" ]]; then
    echo "❌ Error: $BUILD_REQUIRE_CMD not found or not executable!"
    exit 1
  fi

  "$BUILD_REQUIRE_CMD"
}


code_sign() {
  # ================================
  # 2️⃣ Build Code Sign Profile
  # ================================
  CODESIGN_CMD="${RAIDX_SCRIPTS_PATH}/build_codesign_profile.sh"

  if [[ ! -x "$CODESIGN_CMD" ]]; then
    echo "❌ Error: $CODESIGN_CMD not found or not executable!"
    exit 1
  fi

  "$CODESIGN_CMD" \
    "$MODE" \
    "$CLIENT_ID" \
    "$BUILD_ID" \
    "$P12_PATH" \
    "$P12_PASSWORD" \
    "${PROVISION_ID}" \
    "$PROVISION_NAME" \
    "$PROVISION_PATH"
}


build_internal_app() {
  # ================================
  # 3️⃣ Build internal web app + sync
  # ================================
  BUILD_INTERNAL_CMD="${RAIDX_SCRIPTS_PATH}/build_internal_app.sh"

  if [[ ! -x "$BUILD_INTERNAL_CMD" ]]; then
    echo "❌ Error: $BUILD_INTERNAL_CMD not found or not executable!"
    exit 1
  fi

  "$BUILD_INTERNAL_CMD" \
    "$MODE" \
    "$CLIENT_ID" \
    "$BUILD_ID" \
    "$P12_PATH" \
    "$P12_PASSWORD" \
    "$PROVISION_ID" \
    "$PROVISION_NAME" \
    "$PROVISION_PATH"
}

build_update_podfile() {
  # ================================
  # 4️⃣ Update PodFile Configuration
  # ================================
  BUILD_PODFILE_CMD="${RAIDX_SCRIPTS_PATH}/build_update_podfile.sh"

  if [[ ! -x "$BUILD_PODFILE_CMD" ]]; then
    echo "❌ Error: $BUILD_PODFILE_CMD not found or not executable!"
    exit 1
  fi

  "$BUILD_PODFILE_CMD" \
    "$MODE" \
    "$CLIENT_ID" \
    "$BUILD_ID" \
    "$P12_PATH" \
    "$P12_PASSWORD" \
    "$PROVISION_ID" \
    "$PROVISION_NAME" \
    "$PROVISION_PATH"
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ Update PodFile Configuration failed with exit code $EXIT_CODE"
    disposeBuild
  else
    echo "✅ Update PodFile Configuration finished successfully!" 
  fi
}

build_ios_app() {
  # ================================
  # 5️⃣ Build iOS app and Pods (Xcode)
  # ================================
  BUILD_IOS_CMD="${RAIDX_SCRIPTS_PATH}/build_ios_app.sh"

  if [[ ! -x "$BUILD_IOS_CMD" ]]; then
    echo "❌ Error: $BUILD_IOS_CMD not found or not executable!"
    exit 1
  fi

  "$BUILD_IOS_CMD" \
    "$MODE" \
    "$CLIENT_ID" \
    "$BUILD_ID" \
    "$P12_PATH" \
    "$P12_PASSWORD" \
    "$PROVISION_ID" \
    "$PROVISION_NAME" \
    "$PROVISION_PATH"
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ iOS build script failed with exit code $EXIT_CODE"
    disposeBuild
  else
    echo "✅ iOS build script finished successfully!" 
  fi

}
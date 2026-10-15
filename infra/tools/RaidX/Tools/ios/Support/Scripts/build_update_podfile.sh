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

set_header "Update PodFile Configuration"

echo "🚀 Patching Podfile"

# ================================
# INPUTS (from params)
# ================================
MODE="${1:-}"
CLIENT_ID="${2:-}"
BUILD_ID="${3:-}"
P12_PATH="${4:-}"
P12_PASSWORD="${5:-}"
PROVISION_ID="${6:-}"
PROVISION_NAME="${7:-}"
PROVISION_PATH="${8:-}"

if [[ -z "$MODE" || -z "$CLIENT_ID" || -z "$BUILD_ID" || -z "$P12_PATH" || -z "$P12_PASSWORD" || -z "${PROVISION_ID}" || -z "$PROVISION_PATH" || -z "$PROVISION_NAME" ]]; then
  echo "❌ Missing required parameters."
  echo "Usage: $0 MODE CLIENT_ID BUILD_ID P12_PATH P12_PASSWORD PROVISION_ID PROVISION_PATH PROVISION_NAME"
  exit 1
fi

PODFILE="$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/App/$APP_PODFILE_NAME"

# Replace the entire post_install block
sed -i '' '/post_install do |installer|/,/end/ c\
post_install do |installer|\
  assertDeploymentTarget(installer)\
\
  # Workaround build fix 08-19-2025 \
  # The following variables get overriden when\
  # set programmatically.\
  installer.pods_project.targets.each do |target|\
    target.build_configurations.each do |config|\
      config.build_settings['EXPANDED_CODE_SIGN_IDENTITY'] = ""\
      config.build_settings['CODE_SIGNING_REQUIRED'] = "NO"\
      config.build_settings['CODE_SIGNING_ALLOWED'] = "NO"\
    end\
  end\
end
' "$PODFILE"

echo "🎉 Podfile patched!"

# ================================
# Raise deployment targets below what this Xcode supports
# ================================
# Each Xcode drops old iOS versions (Xcode 27: 15.0 minimum), and a project
# still targeting one fails with "IPHONEOS_DEPLOYMENT_TARGET is set to 14.0,
# but the range of supported deployment target versions is 15.0 to …".
# CocoaPods already ran inside `cap sync`, so the Podfile above can't fix
# this - patch the generated projects xcodebuild reads next instead. Only
# values below the SDK's minimum change; higher targets are left alone.
SDK_PATH="$(xcrun --sdk iphoneos --show-sdk-path 2>/dev/null || true)"
MIN_IOS="$(plutil -extract SupportedTargets.iphoneos.MinimumDeploymentTarget raw "$SDK_PATH/SDKSettings.plist" 2>/dev/null || true)"
if [[ ! "$MIN_IOS" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "⚠️ Could not read the iOS SDK's minimum deployment target - leaving deployment targets as-is."
else
  APP_IOS_DIR="$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/App"
  for PBXPROJ in "$APP_IOS_DIR/Pods/Pods.xcodeproj/project.pbxproj" "$APP_IOS_DIR/App.xcodeproj/project.pbxproj"; do
    [[ -f "$PBXPROJ" ]] || continue
    RAISED="$(MIN_IOS="$MIN_IOS" perl -pi -e '
      BEGIN { ($m1, $m2) = split /\./, $ENV{MIN_IOS}; $m2 //= 0; $n = 0 }
      s{(IPHONEOS_DEPLOYMENT_TARGET = )"?(\d+)(?:\.(\d+))?"?;}{
        my ($maj, $min) = ($2, $3 // 0);
        ($maj < $m1 || ($maj == $m1 && $min < $m2)) ? do { $n++; "$1$ENV{MIN_IOS};" } : $&
      }ge;
      END { print STDERR $n }
    ' "$PBXPROJ" 2>&1 >/dev/null)"
    if [[ "${RAISED:-0}" != "0" ]]; then
      echo "⚠️ Raised $RAISED iOS deployment target setting(s) to $MIN_IOS in $(basename "$(dirname "$PBXPROJ")") - this Xcode can't build for older iOS versions."
    fi
  done
fi
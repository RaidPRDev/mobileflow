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

set_header "Build iOS"

echo "🚀 Building App Workspace"

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

# Load the environment variables immediately
ENV_FILE="$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/.ios_build_env"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a              # export all variables automatically
  source "$ENV_FILE"
  set +a
  echo "✅ Environment variables loaded from $ENV_FILE"
else
  echo "❌ Failed to load environment variables from $ENV_FILE"
fi

echo "✅ Get Project Path"
PROJECT_PATH=$(get_project_path)

if [[ "$MODE" == "dev" ]]; then
  echo "📢 Running ios build with:"
  echo "🔹 PROJECT_PATH=$PROJECT_PATH"
  echo "🔹 ARCHIVE_PATH=$ARCHIVE_PATH"
  echo "🔹 EXPORT_PATH=$EXPORT_PATH"
  echo "🔹 DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM"
  echo "🔹 APP_IDENTIFIER=$APP_IDENTIFIER"
  echo "🔹 BUNDLE_ID=$BUNDLE_ID"
  echo "🔹 PROFILE_UUID=$PROFILE_UUID"
  echo "🔹 PROVISION_ID=$PROVISION_ID"
  echo "🔹 PROVISION_NAME=$PROVISION_NAME"
  echo "🔹 CODE_SIGN_IDENTITY=$CODE_SIGN_IDENTITY"
fi

# These should already be set by register_keychain_profile.sh
: "${DEVELOPMENT_TEAM:?Missing DEVELOPMENT_TEAM}"
: "${APP_IDENTIFIER:?Missing APP_IDENTIFIER}"
: "${PROVISION_NAME:?Missing PROVISION_NAME}"
: "${PROFILE_UUID:?Missing PROFILE_UUID}"
: "${CODE_SIGN_IDENTITY:?Missing CODE_SIGN_IDENTITY}"

echo "🛠️  Building iOS archive for scheme: $APP_SCHEME"

build_pods_target() {
    echo "Building CocoaPods target..."
    
    # Build the Pods target first
    xcodebuild build \
        -project "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/App/$PODS_WORKSPACE_NAME" \
        -target "$PODS_TARGET" \
        -configuration "$IOS_CONFIGURATION" \
        -sdk iphoneos \
        ONLY_ACTIVE_ARCH=NO \
        BUILD_LIBRARY_FOR_DISTRIBUTION=YES | xcpretty
    
    if [[ $? -eq 0 ]]; then
        echo "CocoaPods target built successfully"
    else
        echo "Failed to build CocoaPods target"
        exit 1
    fi
}

# Switch to ios project path
cd "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios"

# Clean build directory if it exists
if [ -d "$BUILD_DIR" ]; then
  echo "🧹 Cleaning existing build folder..."
  rm -rf "$BUILD_DIR"
fi

# Ensure build directories exist
mkdir -p "$BUILD_DIR"
mkdir -p "$EXPORT_PATH"

# Resolving Swift Package Manager dependencies...
echo "🧹 Resolving Swift Package Manager dependencies..."
xcodebuild -resolvePackageDependencies -workspace "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/$APP_WORKSPACE_NAME" -scheme "$APP_SCHEME" -destination 'generic/platform=iOS' | xcpretty

# Xcode 26 requires -destination on -showBuildSettings; without it, it errors
# with "Found no destinations for the scheme ... and action build".
xcodebuild -showBuildSettings -workspace "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/$APP_WORKSPACE_NAME" -scheme "$APP_SCHEME" -destination 'generic/platform=iOS' | xcpretty

build_pods_target



echo "📂 Current directory: $(pwd)"

# 1. Archive
xcodebuild \
  -workspace "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/App/App.xcworkspace" \
  -scheme "$APP_SCHEME" \
  -configuration "Release" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  clean \
  archive \
  PROVISIONING_PROFILE="${PROFILE_UUID}" \
  CODE_SIGN_STYLE="Manual" \
  CODE_SIGN_IDENTITY="${CODE_SIGN_IDENTITY}" \
  DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM}" \
  -verbose | xcbeautify

# 2. Generate exportOptions.plist
EXPORT_PLIST="$BUILD_DIR/exportOptions.generated.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>$DEVELOPMENT_TEAM</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key>
    <string>$PROFILE_UUID</string>
  </dict>
  <key>uploadSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
</dict>
</plist>
EOF

# 3. Export IPA
echo "📦 Exporting IPA to: $EXPORT_PATH"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  | xcbeautify

# Capture the exit code
EXIT_CODE=${PIPESTATUS[0]}   # ${PIPESTATUS[0]} is xcodebuild's exit code

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ Export failed (exit code $EXIT_CODE)"
else
  echo "🎉 iOS build completed. Path: $EXPORT_PATH"
fi




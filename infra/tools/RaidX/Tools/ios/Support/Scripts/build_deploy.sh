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

set_header "Deploy to AppStore"

echo "🚀 Starting iOS Submission"

# ================================
# INPUTS (from params)
# ================================

# * Required
# Path to the IPA file to be uploaded
# Value: Absolute path to the .ipa file (e.g., /Users/username/MyApp.ipa)
IPA_FILE="${1:-}"

# * Required
# Platform type of the app
# Values: ios (for iOS apps), macos (for macOS apps), tvos (for tvOS apps)
PLATFORM_TYPE="${2:-}"

# * Required
# Apple ID email associated with the Apple Developer Program
# Value: Your Apple ID email (e.g., user@example.com)
APPLE_ID="${3:-}"

# * Required
# App-specific password for authentication
# Value: 16-character app-specific password generated at appleid.apple.com (e.g., abcd-efgh-ijkl-mnop)
APP_SPECIFIC_PASSWORD="${4:-}"

# * Optional
# Enable verbose logging for debugging
# Value: Set to "--verbose" to enable, or leave empty ("") to disable
VERBOSE="${5:-}"

# * Optional
# Alternative to APPLE_ID and APP_SPECIFIC_PASSWORD: API Key ID for App Store Connect
# Value: API key ID from App Store Connect (e.g., ABC123DEF4)
# Note: Uncomment to use API key authentication instead of username/password
API_KEY="${6:-}"

# * Optional
# Issuer ID for the App Store Connect API key (used with API_KEY)
# Value: Issuer ID from App Store Connect (e.g., 69a6de7f-1234-1234-1234-1234567890ab)
API_ISSUER="${7:-}"

if [[ -z "$IPA_FILE" || -z "$PLATFORM_TYPE" || -z "$APPLE_ID" || -z "$APP_SPECIFIC_PASSWORD" ]]; then
  echo "❌ Missing required parameters."
  echo "Usage: $0 IPA_FILE PLATFORM_TYPE APPLE_ID APP_SPECIFIC_PASSWORD"
  exit 1
fi

# Output format for the command response
# Values: normal (human-readable), json (structured JSON), xml (structured XML)
OUTPUT_FORMAT="json"

# Execute the upload command with username/password authentication
# xcrun altool --upload-app --type ios --file "/path/to/your/app.ipa" --username "your_apple_id" --password "app_specific_password"

xcrun altool --upload-app --type "$PLATFORM_TYPE" \
  --file "$IPA_FILE" \
  --username "$APPLE_ID" \
  --password "$APP_SPECIFIC_PASSWORD" \
  --output-format "$OUTPUT_FORMAT" \
  "$VERBOSE" | xcbeautify

echo "🎉 iOS App has been deployed!"

# Alternative command using API key authentication (uncomment to use)

# xcrun altool --upload-app --type "$PLATFORM_TYPE" \
#   --file "$IPA_FILE" \
#   --apiKey "$API_KEY" \
#   --apiIssuer "$API_ISSUER" \
#   --output-format "$OUTPUT_FORMAT" \
#   "$VERBOSE" | xcbeautify
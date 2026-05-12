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
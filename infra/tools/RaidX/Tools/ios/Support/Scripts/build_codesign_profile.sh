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

set_header "CodeSign Profile"

echo "🚀 Starting iOS Setup"

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

# Derive a per-build keychain (raidx-<BUILD_ID>.keychain-db). Concurrent builds
# on the same Mac never read or destroy each other's certs because each build
# gets its own keychain file + password.
set_build_keychain "$BUILD_ID"

if [[ "$MODE" == "dev" ]]; then
  echo "📢 Running ios build with:"
  echo "🔹 CLIENT_ID=$CLIENT_ID"
  echo "🔹 BUILD_ID=$BUILD_ID"
  echo "🔹 P12_PATH=$P12_PATH"
  echo "🔹 P12_PASSWORD=**********"
  echo "🔹 PROVISION_ID=${PROVISION_ID}"
  echo "🔹 PROVISION_PATH=$PROVISION_PATH"
  echo "🔹 PROVISION_NAME=$PROVISION_NAME"
  echo "🔹 KEYCHAIN_NAME=$KEYCHAIN_NAME"
  echo "🔹 KEYCHAIN_PATH=$KEYCHAIN_PATH"
fi

# Build env file is read by downstream scripts (build_ios_app.sh, dispose).
# We write it at the end of this script in one block, but track the values
# we want to persist in this temp file as we go.
ENV_FILE="$HOME/RaidX/Clients/$CLIENT_ID/$BUILD_ID/.ios_build_env"
mkdir -p "$(dirname "$ENV_FILE")"

# ================================
# 1️⃣ CREATE PER-BUILD KEYCHAIN
# ================================
# If a previous attempt of THIS build left a keychain around, remove it first.
# We don't touch any other tenant's keychain — KEYCHAIN_NAME embeds BUILD_ID
# so we can only ever match our own.
if [ -f "$KEYCHAIN_PATH" ]; then
  echo "📢 Removing previous attempt's keychain: $KEYCHAIN_PATH"
  security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
  rm -f "$KEYCHAIN_PATH"
fi

echo "🔑 Creating keychain: $KEYCHAIN_PATH"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Add ours to the search list ALONGSIDE the existing keychains. Setting the
# list without preserving existing entries would knock other tenants' build
# keychains (and the user's login keychain) out of view.
# Sanitise the existing list before adding ours. Older versions of this
# script accumulated cruft (the bare keychains dir, duplicate entries) via
# lossy read-modify-write; this awk keeps only well-formed unique paths.
EXISTING_KEYCHAINS=$(
  security list-keychains -d user | awk '
    { gsub(/"/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); }
    /\.keychain(-db)?$/ && !seen[$0]++
  '
)
with_keychain_search_lock list-keychains -d user -s "$KEYCHAIN_NAME" $EXISTING_KEYCHAINS

# Save the user's previous default keychain so dispose can restore it. We do
# NOT make ours the default — `xcodebuild`/`codesign` find identities via the
# search list, so there's no need to mutate global state. (If a future
# requirement does force this, restore on dispose using PREVIOUS_DEFAULT_KEYCHAIN
# below.)
PREVIOUS_DEFAULT_KEYCHAIN=$(security default-keychain -d user 2>/dev/null | tr -d ' "' || true)
echo "📌 Saved previous default keychain: $PREVIOUS_DEFAULT_KEYCHAIN"

# Unlock and set a long timeout so xcodebuild doesn't get a re-lock mid-sign.
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -t 3600 -l "$KEYCHAIN_NAME"

# (No cross-keychain certificate cleanup. Our keychain is fresh and empty;
# scrubbing other keychains for matching CNs was the legacy behaviour that
# wiped other tenants' "iPhone Distribution: Foo" certs.)

# ================================
# 2️⃣ IMPORT P12 CERTIFICATE
# ================================
if [ ! -f "$P12_PATH" ]; then
  echo "❌ P12 file not found: $P12_PATH"
  exit 1
fi

echo "🔑 Importing P12 certificate: $P12_PATH"
security import "$P12_PATH" \
  -P "${P12_PASSWORD}" \
  -k "${KEYCHAIN_NAME}" \
  -T /usr/bin/codesign \
  -T /usr/bin/xcodebuild \
  -A

# Newer macOS versions require explicit partition-list permission for Apple
# code-signing tools to use the imported key non-interactively.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" >/dev/null 2>&1 || {
  echo "⚠️ Warning: set-key-partition-list failed — Apple tools may prompt on first use"
}
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# ================================
# 3️⃣ EXTRACT CODE_SIGN_IDENTITY
# ================================
echo "🔍 Available code signing identities in $KEYCHAIN_NAME:"
security find-identity -p codesigning -v "$KEYCHAIN_NAME" || true

CODE_SIGN_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_NAME" 2>/dev/null \
  | awk -F '"' '/iPhone Distribution|Apple Distribution|iPhone Developer|Apple Development/ {print $2; exit}')

if [ -z "$CODE_SIGN_IDENTITY" ]; then
  # find-identity -p codesigning requires a valid trust chain; if the Apple
  # WWDR intermediate isn't visible to this keychain it returns zero matches.
  # Fall back to scraping the certificate label directly. xcodebuild signs by
  # the identity string, so this still produces a working build.
  echo "⚠️  find-identity returned 0 matches under the codesigning policy."
  echo "    Falling back to keychain dump (trust chain may be incomplete)."
  CODE_SIGN_IDENTITY=$(security dump-keychain "$KEYCHAIN_NAME" 2>/dev/null \
    | grep -A1 '"labl"<blob>=' \
    | grep -E 'iPhone Distribution|Apple Distribution|iPhone Developer|Apple Development' \
    | sed 's/.*"labl"<blob>="\([^"]*\)".*/\1/' \
    | head -1)
fi

if [ -z "$CODE_SIGN_IDENTITY" ]; then
  echo "❌ Could not determine CODE_SIGN_IDENTITY from the imported .p12."
  echo "🔍 Debug — keychain contents:"
  security dump-keychain "$KEYCHAIN_NAME" 2>/dev/null | grep -E '"labl"<blob>=' || true
  exit 1
fi
echo "✅ CODE_SIGN_IDENTITY: $CODE_SIGN_IDENTITY"

# ================================
# 4️⃣ INSTALL PROVISIONING PROFILE
# ================================
if [ ! -f "$PROVISION_PATH" ]; then
  echo "❌ Provisioning profile not found: $PROVISION_PATH"
  exit 1
fi

echo "📱 Installing provisioning profile: $PROVISION_PATH"
echo "🔍 Extracting provisioning profile information..."

TMP_PLIST=$(mktemp "${TMPDIR:-/tmp}/profile.XXXXXX.plist")
security cms -D -i "$PROVISION_PATH" > "$TMP_PLIST"

DEVELOPMENT_TEAM=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$TMP_PLIST")
APP_IDENTIFIER=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$TMP_PLIST")
BUNDLE_ID=${APP_IDENTIFIER#*.}
PROFILE_UUID=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$TMP_PLIST" 2>/dev/null || echo "")
rm -f "$TMP_PLIST"

if [ -z "$DEVELOPMENT_TEAM" ] || [ -z "$APP_IDENTIFIER" ] || [ -z "$BUNDLE_ID" ] || [ -z "$PROFILE_UUID" ]; then
  echo "❌ Failed to parse provisioning profile (DEVELOPMENT_TEAM/APP_IDENTIFIER/BUNDLE_ID/UUID missing)."
  exit 1
fi

# Profiles are installed by UUID — UUIDs are globally unique so there's no
# cross-tenant collision risk. We deliberately DO NOT remove "matching"
# profiles by name pattern (legacy behaviour), because another tenant may
# have a profile whose display name happens to share a prefix.
mkdir -p "$PROVISION_FOLDER"
cp "$PROVISION_PATH" "$PROVISION_FOLDER/$PROFILE_UUID.mobileprovision"
echo "✅ Provisioning profile installed: $PROVISION_FOLDER/$PROFILE_UUID.mobileprovision"

# Track installed UUIDs (newline-separated) so dispose removes only what this
# build added — never another build's profile.
INSTALLED_PROFILE_UUIDS="$PROFILE_UUID"

# ================================
# 5️⃣ SUMMARY
# ================================
echo "✅ Provisioning Profile Information:"
echo "   🆔 DEVELOPMENT_TEAM: $DEVELOPMENT_TEAM"
echo "   📱 APP_IDENTIFIER: $APP_IDENTIFIER"
echo "   📦 BUNDLE_ID: $BUNDLE_ID"
echo "   📋 PROFILE_UUID: $PROFILE_UUID"
echo "   🔑 CODE_SIGN_IDENTITY: $CODE_SIGN_IDENTITY"

# ================================
# 6️⃣ WRITE BUILD ENV FILE
# ================================
{
  echo "export DEVELOPMENT_TEAM=\"$DEVELOPMENT_TEAM\""
  echo "export APP_IDENTIFIER=\"$APP_IDENTIFIER\""
  echo "export BUNDLE_ID=\"$BUNDLE_ID\""
  echo "export PROFILE_UUID=\"$PROFILE_UUID\""
  echo "export CODE_SIGN_IDENTITY=\"$CODE_SIGN_IDENTITY\""
  # Keychain identity + secrets, so build_ios_app.sh can unlock and dispose
  # can clean up. The .ios_build_env lives under the per-build directory
  # which is already client-scoped — same trust boundary as the .p12 we
  # uploaded.
  echo "export KEYCHAIN_NAME=\"$KEYCHAIN_NAME\""
  echo "export KEYCHAIN_PATH=\"$KEYCHAIN_PATH\""
  echo "export KEYCHAIN_PASSWORD=\"$KEYCHAIN_PASSWORD\""
  echo "export PREVIOUS_DEFAULT_KEYCHAIN=\"$PREVIOUS_DEFAULT_KEYCHAIN\""
  echo "export INSTALLED_PROFILE_UUIDS=\"$INSTALLED_PROFILE_UUIDS\""
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "✅ Environment variables written to $ENV_FILE"
echo "✅ Keychain and provisioning profile setup complete!"
echo "🎉 iOS Code Signing complete!"

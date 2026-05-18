#!/bin/bash
set -euo pipefail

# ===========================================
# Per-build cleanup. Removes ONLY artefacts this
# build created — the keychain it imported, the
# provisioning profile UUIDs it installed, and
# its client/build working directory.
#
# Multi-tenant safety: this script must never
# touch another build's keychain, profile, or
# cache. All "matching" deletes happen by exact
# BUILD_ID-scoped name or by tracked UUID.
# ===========================================

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

set_header "Build Dispose"

echo "🗑️  Removing build cache files"

# ================================
# INPUTS (from params)
# ================================
MODE="${1:-}"
CLIENT_ID="${2:-}"
BUILD_ID="${3:-}"

if [[ -z "$MODE" || -z "$CLIENT_ID" || -z "$BUILD_ID" ]]; then
  echo "❌ Missing required parameters."
  echo "Usage: $0 MODE CLIENT_ID BUILD_ID"
  exit 1
fi

# Load this build's env file so we know which profiles + keychain to clean.
# It's written by build_codesign_profile.sh and contains
# KEYCHAIN_NAME, KEYCHAIN_PASSWORD, PREVIOUS_DEFAULT_KEYCHAIN, INSTALLED_PROFILE_UUIDS.
ENV_FILE="$HOME/RaidX/Clients/$CLIENT_ID/$BUILD_ID/.ios_build_env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# If the build env didn't make it (e.g. codesign step crashed before writing
# it), fall back to deriving the per-build keychain name from BUILD_ID. We
# still won't touch anyone else's keychain because the name embeds BUILD_ID.
if [[ -z "${KEYCHAIN_NAME:-}" || -z "${KEYCHAIN_PATH:-}" ]]; then
  set_build_keychain "$BUILD_ID"
fi

if [[ "$MODE" == "dev" ]]; then
  echo "🔹 CLIENT_ID=$CLIENT_ID"
  echo "🔹 BUILD_ID=$BUILD_ID"
  echo "🔹 KEYCHAIN_NAME=$KEYCHAIN_NAME"
  echo "🔹 KEYCHAIN_PATH=$KEYCHAIN_PATH"
  echo "🔹 INSTALLED_PROFILE_UUIDS=${INSTALLED_PROFILE_UUIDS:-}"
  echo "🔹 PREVIOUS_DEFAULT_KEYCHAIN=${PREVIOUS_DEFAULT_KEYCHAIN:-}"
fi

# ================================
# 1️⃣ REMOVE OUR KEYCHAIN FROM SEARCH LIST (preserve others)
# ================================
# `security list-keychains -s ...` REPLACES the search list, so we have to
# read it, filter out our own keychain, and write the rest back. Anything
# else (login keychain, other tenants' build keychains) stays intact.
if [ -n "${KEYCHAIN_NAME:-}" ]; then
  echo "🔗 Removing $KEYCHAIN_NAME from keychain search list (keeping others)…"
  CURRENT_LIST=$(security list-keychains -d user | tr -d '"' | xargs)
  FILTERED=()
  for kc in $CURRENT_LIST; do
    # Match either the bare name or the full -db path so we catch both forms.
    case "$kc" in
      */${KEYCHAIN_NAME}-db|${KEYCHAIN_PATH}|${KEYCHAIN_NAME}) continue ;;
      *) FILTERED+=("$kc") ;;
    esac
  done
  if [ ${#FILTERED[@]} -gt 0 ]; then
    with_keychain_search_lock list-keychains -d user -s "${FILTERED[@]}"
  else
    # Don't leave the list empty — Apple treats that as "use default only".
    with_keychain_search_lock list-keychains -d user -s login.keychain-db
  fi
fi

# ================================
# 2️⃣ RESTORE PREVIOUS DEFAULT KEYCHAIN
# ================================
# build_codesign_profile.sh saved the user's previous default before we
# touched anything. Restore it so any other tool/shell that reads the
# default keychain sees the state it expects.
if [ -n "${PREVIOUS_DEFAULT_KEYCHAIN:-}" ] && [ "${PREVIOUS_DEFAULT_KEYCHAIN}" != "${KEYCHAIN_PATH:-}" ]; then
  echo "♻️  Restoring previous default keychain: $PREVIOUS_DEFAULT_KEYCHAIN"
  security default-keychain -d user -s "$PREVIOUS_DEFAULT_KEYCHAIN" 2>/dev/null || \
    echo "⚠️  Could not restore previous default keychain (it may have been removed)."
fi

# ================================
# 3️⃣ DELETE OUR KEYCHAIN FILE
# ================================
if [ -n "${KEYCHAIN_NAME:-}" ]; then
  echo "🗑️  Deleting keychain: $KEYCHAIN_NAME ($KEYCHAIN_PATH)"
  security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
  # delete-keychain usually removes the file too, but be defensive.
  [ -n "${KEYCHAIN_PATH:-}" ] && rm -f "$KEYCHAIN_PATH"
  echo "✅ Keychain removed."
fi

# ================================
# 4️⃣ REMOVE PROVISIONING PROFILES THIS BUILD INSTALLED
# ================================
# Only the UUIDs we tracked in .ios_build_env. We never remove by display
# name — another tenant may have a profile with a similar name.
if [ -n "${INSTALLED_PROFILE_UUIDS:-}" ]; then
  for uuid in $INSTALLED_PROFILE_UUIDS; do
    profile="$PROVISION_FOLDER/$uuid.mobileprovision"
    if [ -f "$profile" ]; then
      rm -f "$profile"
      echo "🗑️  Removed provisioning profile $uuid"
    fi
  done
fi

# ================================
# 5️⃣ PER-BUILD WORKSPACE CLEANUP
# ================================
# The client/build directory is scoped to this build, so it's safe to remove
# in full. Everything that lives outside this path (DerivedData, Archives,
# ~/Library/Caches, simulator state, brew/npm caches, ~/.gem) is shared with
# every other tenant on this Mac and must NOT be wiped per-build. If those
# caches need pruning, run a separate maintenance job on a schedule.
BUILD_DIR="$HOME/RaidX/Clients/$CLIENT_ID/$BUILD_ID"
if [ -d "$BUILD_DIR" ]; then
  echo "🗑️  Removing build workspace: $BUILD_DIR"
  rm -rf "$BUILD_DIR"
fi

echo "==========================================="
echo "✅ Cleanup complete (per-build scope)."
echo "==========================================="

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

# ================================
# 1️⃣ DELETE EXISTING KEYCHAIN
# ================================
echo "🔗 Removing $KEYCHAIN_NAME from keychain search list..."
# This prevents the system from trying to find a non-existent keychain
# The 'tr' command cleans up the output, and 'xargs' passes it as arguments
security list-keychains -d user | tr -d '"' | sed "s|$KEYCHAIN_NAME||" | xargs security list-keychains -d user -s 2>/dev/null

if [ -f "$KEYCHAIN_PATH" ]; then
  echo "📢 Deleting existing keychain: $KEYCHAIN_PATH"
 
  security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
  rm -f "$KEYCHAIN_NAME"
  sleep 1
  if [ ! -f "$KEYCHAIN_PATH" ]; then
    echo "✅ Successfully deleted keychain file."
  else
    echo "⚠️ Could not delete keychain file, manual cleanup may be needed."
  fi
  
  echo "🗑️  $KEYCHAIN_PATH has been deleted."
fi

# dev_stop


# ================================
# 2️⃣ CREATE AND CONFIGURE KEYCHAIN
# ================================
echo "🔑 Creating keychain: $KEYCHAIN_PATH"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Add it to the keychain search list (preserve existing keychains)
EXISTING_KEYCHAINS=$(security list-keychains -d user | tr -d '"' | xargs)
security list-keychains -d user -s "$KEYCHAIN_NAME" $EXISTING_KEYCHAINS

# Set as default keychain
security default-keychain -s "$KEYCHAIN_PATH"

# Unlock it
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Configure timeout (1 hour)
security set-keychain-settings -t 3600 -l "$KEYCHAIN_NAME"


# ================================
# 3️⃣ REMOVE DUPLICATE CERTIFICATES
# ================================
echo "🧹 Checking for existing certificates in keychain..."
# Function to remove certificates by common name pattern
remove_certificates_by_pattern() {
  local pattern="$1"
  
  echo "🔍 Looking for certificates matching pattern: $pattern in all keychains"
  
  # Find certificates in all keychains (login, system, etc.)
  local cert_info=$(security find-certificate -a -c "$pattern" 2>/dev/null)
  
  if [ -n "$cert_info" ]; then
    echo "📋 Found certificates matching '$pattern':"
    
    # Extract keychain paths and SHA-1 hashes
    local current_keychain=""
    local current_hash=""
    local cert_subject=""
    
    while IFS= read -r line; do
      if [[ "$line" =~ keychain:\ \"(.+)\" ]]; then
        current_keychain="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ \"subj\".*CN=([^,]+) ]]; then
        cert_subject="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ SHA-1\ hash:\ ([A-F0-9]+) ]]; then
        current_hash="${BASH_REMATCH[1]}"
        if [ -n "$current_keychain" ] && [ -n "$current_hash" ]; then
          echo "  📋 Found: ${cert_subject:-Unknown Subject}"
          echo "  🗑️ Removing from keychain: $(basename "$current_keychain")"
          echo "     Hash: $current_hash"
          security delete-certificate -Z "$current_hash" "$current_keychain" 2>/dev/null || {
            echo "     ⚠️  Could not remove (might not have permission)"
          }
          current_hash=""
          cert_subject=""
        fi
      fi
    done <<< "$cert_info"
    
  else
    echo "✅ No existing certificates found matching pattern: $pattern"
  fi
}

# Also check what certificates are currently visible
echo "📋 Current code signing identities across all keychains:"
security find-identity -v -p codesigning 2>/dev/null || echo "No code signing identities found"

# Remove common certificate types that might conflict
remove_certificates_by_pattern "iPhone Distribution" "$KEYCHAIN_NAME"
remove_certificates_by_pattern "iPhone Development" "$KEYCHAIN_NAME"
remove_certificates_by_pattern "Apple Distribution" "$KEYCHAIN_NAME"
remove_certificates_by_pattern "Apple Development" "$KEYCHAIN_NAME"

echo "🧹 Certificate cleanup complete"


# ================================
# 4️⃣ REMOVE OLD PROVISIONING PROFILES
# ================================
echo "🧹 Removing old provisioning profiles matching: $PROVISION_NAME from Path: $PROVISION_FOLDER"
echo "🧹 Path: $PROVISION_FOLDER"

mkdir -p "$PROVISION_FOLDER"
if [ -n "$PROVISION_NAME" ]; then
  rm -f "$PROVISION_FOLDER/${PROVISION_NAME}"*.mobileprovision 2>/dev/null || true
  echo "✅ Cleaned up old provisioning profiles"
else
  echo "⚠️ PROVISION_NAME not set, skipping provisioning profile cleanup"
fi


# ================================
# 5️⃣ IMPORT P12 CERTIFICATE
# ================================
if [ -f "$P12_PATH" ]; then
  echo "🔑 Importing P12 certificate: $P12_PATH"

  # Import the P12 certificate
  security import "$P12_PATH" \
    -P "${P12_PASSWORD}" \
    -k "${KEYCHAIN_NAME}" \
    -T /usr/bin/codesign \
    -T /usr/bin/xcodebuild \
    -A

  # Allow Xcode & Apple tools to use it
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" 2>/dev/null || {
    echo "⚠️ Warning: Could not set key partition list. This might cause issues on newer macOS versions."
  }

  # Allow Xcode & Apple tools to use it
  # security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
  
  # Re-unlock keychain after operations
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
  
  echo "🔍 Available code signing identities after setup:"
  security find-identity -p codesigning -v "$KEYCHAIN_NAME"


  # ================================
  # 📢 EXTRACT CODE_SIGN_IDENTITY
  # ================================
  echo "🔍 Extracting code signing identity..."
  
  # First, let's see what we actually have in the keychain
  echo "📋 All items in keychain:"
  security dump-keychain "$KEYCHAIN_NAME" 2>/dev/null | grep -E "(labl|subj)" || echo "Could not dump keychain contents"
  
  # Try multiple approaches to find the identity
  echo "🔍 Approach 1: Looking for codesigning identities in specific keychain..."
  CODE_SIGN_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_NAME" 2>/dev/null \
    | awk -F '"' '/iPhone Distribution|Apple Distribution/ {print $2; exit}')
  
  if [ -z "$CODE_SIGN_IDENTITY" ]; then
    echo "🔍 Approach 2: Looking for any iPhone certificate..."
    CODE_SIGN_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_NAME" 2>/dev/null \
      | awk -F '"' '/iPhone/ {print $2; exit}')
  fi
  
  if [ -z "$CODE_SIGN_IDENTITY" ]; then
    echo "🔍 Approach 3: Looking across all keychains..."
    CODE_SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
      | awk -F '"' '/iPhone Distribution|Apple Distribution/ {print $2; exit}')
  fi
  
  if [ -z "$CODE_SIGN_IDENTITY" ]; then
    echo "🔍 Approach 4: Extracting from keychain dump..."
    # Extract the label directly from keychain dump
    CODE_SIGN_IDENTITY=$(security dump-keychain "$KEYCHAIN_NAME" 2>/dev/null \
      | grep -A1 '"labl"<blob>=' \
      | grep 'iPhone Distribution\|Apple Distribution' \
      | sed 's/.*"labl"<blob>="\([^"]*\)".*/\1/' \
      | head -1)
    
    if [ -n "$CODE_SIGN_IDENTITY" ]; then
      echo "📋 Extracted from keychain dump: $CODE_SIGN_IDENTITY"
    fi
  fi
  
  # Final verification
  if [ -n "$CODE_SIGN_IDENTITY" ]; then
    echo "✅ CODE_SIGN_IDENTITY found: $CODE_SIGN_IDENTITY"
    export CODE_SIGN_IDENTITY
    
    # Test if we can actually use this identity for codesigning
    echo "🧪 Testing code signing identity access..."
    
    # Method 1: Try to find it in codesigning identities
    if security find-identity -v -p codesigning | grep -q "$CODE_SIGN_IDENTITY"; then
      echo "✅ Identity is accessible via find-identity codesigning"
    else
      echo "⚠️  Identity not found in codesigning list, but certificate exists"
      
      # Method 2: Try to verify we can access the private key
      echo "🔑 Checking private key access..."
      if security find-key -a "$KEYCHAIN_NAME" 2>/dev/null | grep -q "Mark Mastro"; then
        echo "✅ Private key found and accessible"
      else
        echo "⚠️  Private key access issue detected"
        echo "🔄 Attempting to fix keychain access..."
        
        # Try to fix access issues
        security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
        security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME" 2>/dev/null
        
        # Re-test
        if security find-identity -v -p codesigning | grep -q "$CODE_SIGN_IDENTITY"; then
          echo "✅ Fixed! Identity now accessible"
        else
          echo "⚠️  Manual intervention may be needed"
        fi
      fi
    fi
    
    # Show final status
    echo "📋 Final identity verification:"
    echo "   Identity String: $CODE_SIGN_IDENTITY"
    echo "   Keychain: $KEYCHAIN_NAME"
    
  else
    echo "❌ CODE_SIGN_IDENTITY could not be determined"
    echo "🔍 Debug: All available identities across all keychains:"
    security find-identity -v -p codesigning 2>/dev/null || echo "No identities found"
    echo "🔍 Debug: Contents of build keychain:"
    security find-identity -v "$KEYCHAIN_NAME" 2>/dev/null || echo "No identities in build keychain"
    echo "🔍 Debug: Certificate labels in keychain:"
    security dump-keychain "$KEYCHAIN_NAME" 2>/dev/null | grep '"labl"<blob>=' || echo "No labels found"
    exit 1
  fi

else
  echo "❌ P12 file not found: $P12_PATH"
  exit 1
fi

# ================================
# 6️⃣ INSTALL PROVISIONING PROFILE
# ================================
if [ -f "$PROVISION_PATH" ]; then
  echo "📱 Installing provisioning profile: $PROVISION_PATH"
  
  # Extract provisioning profile information
  echo "🔍 Extracting provisioning profile information..."

  TMP_PLIST=$(mktemp "${TMPDIR:-/tmp}/profile.XXXXXX.plist")
  security cms -D -i "$PROVISION_PATH" > "$TMP_PLIST"

  DEVELOPMENT_TEAM=$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$TMP_PLIST")
  APP_IDENTIFIER=$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$TMP_PLIST")
  BUNDLE_ID=${APP_IDENTIFIER#*.}
  PROFILE_UUID=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$TMP_PLIST" 2>/dev/null || echo "")

  if [ -z "$DEVELOPMENT_TEAM" ]; then
    echo "⚠️ Could not parse DEVELOPMENT_TEAM, copied file directly"
    exit 1
  fi
  if [ -z "$APP_IDENTIFIER" ]; then
    echo "⚠️ Could not parse APP_IDENTIFIER, copied file directly"
    exit 1
  fi
  if [ -z "$BUNDLE_ID" ]; then
    echo "⚠️ Could not parse BUNDLE_ID, copied file directly"
    exit 1
  fi
  if [ -z "$PROFILE_UUID" ]; then
    echo "⚠️ Could not parse UUID, copied file directly"
    exit 1
  fi
  
  # Clean up temporary file
  rm -f "$TMP_PLIST"
    
  # Copy to provisioning profiles folder using UUID
  cp "$PROVISION_PATH" "$PROVISION_FOLDER/$PROFILE_UUID.mobileprovision"
  echo "✅ Provisioning profile installed to: $PROVISION_FOLDER/"

else
  echo "❌ Provisioning profile not found: $PROVISION_PATH"
  exit 1
fi


# ================================
# 7️⃣ VERIFY SETUP
# ================================
echo "🔍 Verifying keychain setup..."
echo "📋 Keychain list:"
security list-keychains -d user

echo "📋 Certificates in build keychain:"
security find-certificate -a -p "$KEYCHAIN_NAME" | openssl x509 -text -noout | grep "Subject:" || echo "No certificates found"

echo "📋 Code signing identities:"
security find-identity -v -p codesigning "$KEYCHAIN_NAME"

# Display extracted information
echo "✅ Provisioning Profile Information:"
echo "   🆔 DEVELOPMENT_TEAM: $DEVELOPMENT_TEAM"
echo "   📱 APP_IDENTIFIER: $APP_IDENTIFIER"
echo "   📦 BUNDLE_ID: $BUNDLE_ID"
echo "   📋 PROFILE_UUID: $PROFILE_UUID"
echo "   🔑 CODE_SIGN_IDENTITY: $CODE_SIGN_IDENTITY"


# # ================================
# 8️⃣ EXPORT ENVIRONMENT VARIABLES
# ================================

ENV_FILE="$HOME/RaidX/Clients/$CLIENT_ID/$BUILD_ID/.ios_build_env"
echo "export DEVELOPMENT_TEAM=\"$DEVELOPMENT_TEAM\"" > "$ENV_FILE"
echo "export APP_IDENTIFIER=\"$APP_IDENTIFIER\"" >> "$ENV_FILE"
echo "export BUNDLE_ID=\"$BUNDLE_ID\"" >> "$ENV_FILE"
echo "export PROFILE_UUID=\"$PROFILE_UUID\"" >> "$ENV_FILE"
echo "export CODE_SIGN_IDENTITY=\"$CODE_SIGN_IDENTITY\"" >> "$ENV_FILE"
echo "✅ Environment variables written to $ENV_FILE"
echo "✅ Keychain and provisioning profile setup complete!"

echo "🎉 iOS Code Signing complete!"

# dev_stop
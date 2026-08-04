#!/bin/bash

# RaidX Scripts
source "$RAIDX_SCRIPTS_PATH/utils/timers.sh"
source "$RAIDX_SCRIPTS_PATH/utils/visual_loaders.sh"
source "$RAIDX_SCRIPTS_PATH/utils/general.sh"

# --- Toolchain PATH bootstrap for non-interactive SSH ---
#
# The worker invokes us through `bash -lc`. A *bash* login shell reads
# ~/.bash_profile / ~/.profile — it never reads ~/.zprofile, which is where
# Homebrew's installer (and our install_requirements.sh) writes `brew shellenv`.
# On a stock Mac that means brew's node / pod / xcbeautify are absent here even
# though they work fine in the user's own zsh terminal. So rebuild the
# environment explicitly rather than trusting the login shell to do it.

raidx_path_prepend() {
  [ -d "$1" ] || return 0
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
  export PATH
}

# Homebrew: Apple Silicon prefix first, then Intel.
for raidx_brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$raidx_brew" ]; then
    eval "$("$raidx_brew" shellenv)"
    break
  fi
done
unset raidx_brew

# Ruby: rbenv shims, then the version-scoped user gem dirs a non-sudo
# `gem install cocoapods` writes its binaries to.
raidx_path_prepend "$HOME/.rbenv/shims"
for raidx_gem_bin in "$HOME"/.gem/ruby/*/bin "$HOME"/.local/share/gem/ruby/*/bin; do
  raidx_path_prepend "$raidx_gem_bin"
done
unset raidx_gem_bin
raidx_path_prepend "/usr/local/bin"

# Node version managers install outside Homebrew and only wire node onto PATH
# from an interactive shell's rc file (nvm from ~/.zshrc, typically), so a node
# that works fine in the user's terminal is invisible to us. Resolve it from
# disk instead of sourcing nvm.sh, which doesn't survive `set -euo pipefail`.
if ! command -v node >/dev/null 2>&1; then
  raidx_path_prepend "$HOME/.volta/bin"
  raidx_path_prepend "$HOME/.local/share/fnm/aliases/default/bin"
fi
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  raidx_nvm_dir=""
  raidx_nvm_alias=""
  if [ -f "$HOME/.nvm/alias/default" ]; then
    raidx_nvm_alias="$(cat "$HOME/.nvm/alias/default" 2>/dev/null)" || raidx_nvm_alias=""
  fi
  # A concrete alias ("20.11.0" / "v20.11.0") names one install directly.
  # Symbolic ones ("lts/*", "node", "stable") don't, so fall back to the
  # newest version installed.
  if [ -n "$raidx_nvm_alias" ] && [ -d "$HOME/.nvm/versions/node/v${raidx_nvm_alias#v}" ]; then
    raidx_nvm_dir="$HOME/.nvm/versions/node/v${raidx_nvm_alias#v}"
  else
    raidx_nvm_ver="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | { sort -V 2>/dev/null || sort; } | tail -n1)" || raidx_nvm_ver=""
    # Explicit if, not `[ ... ] && ...`: under `set -e` a trailing AND-list
    # whose test fails takes the whole script down with it.
    if [ -n "$raidx_nvm_ver" ]; then
      raidx_nvm_dir="$HOME/.nvm/versions/node/$raidx_nvm_ver"
    fi
  fi
  if [ -n "$raidx_nvm_dir" ] && [ -x "$raidx_nvm_dir/bin/node" ]; then
    raidx_path_prepend "$raidx_nvm_dir/bin"
    echo "🔹 Using nvm node: $("$raidx_nvm_dir/bin/node" -v) ($raidx_nvm_dir)"
  fi
  unset raidx_nvm_dir raidx_nvm_alias raidx_nvm_ver
fi

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
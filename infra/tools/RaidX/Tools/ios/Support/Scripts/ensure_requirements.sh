#!/bin/bash
set -euo pipefail

# Idempotent toolchain bootstrap for the iOS build Mac.
#
# Run automatically at the end of `pnpm deploy:build-scripts:ios` (skip with
# --no-requirements), and safe to run by hand at any time:
#
#   bash ~/RaidX/Tools/Support/Scripts/ensure_requirements.sh
#   bash ~/RaidX/Tools/Support/Scripts/ensure_requirements.sh --check
#
# Anything already present is left alone, so a repeat run is a no-op that just
# prints versions.
#
# Two classes of tooling:
#   - BREW_REQUIRED  installed automatically via Homebrew when missing.
#   - CHECK_ONLY     reported but never installed — node comes from whichever
#                    version manager the host already uses (nvm here), and
#                    Xcode has to be installed from the App Store. Silently
#                    layering a second toolchain on top would be worse than
#                    telling a human what's wrong.
#
# Unlike install_requirements.sh (the full from-scratch provisioner that
# compiles Ruby via rbenv), this only closes the gap between "what the build
# needs" and "what the Mac has".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPORT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export RAIDX_SCRIPTS_PATH="$SCRIPT_DIR"

CHECK_ONLY_MODE="false"
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY_MODE="true"
fi

# Source the same PATH bootstrap the build uses (Homebrew shellenv, rbenv
# shims, user gem bins, nvm/fnm/volta node) so "is it installed?" is answered
# in exactly the environment the build will run in — not in the richer one an
# interactive terminal would give us. Deliberately not globals.sh: that file
# hard-requires MAC_SERVER_* via `${VAR:?}` strict expansion, which only the
# worker injects.
if [ -f "$SUPPORT_DIR/includes.sh" ]; then
  # shellcheck source=/dev/null
  source "$SUPPORT_DIR/includes.sh"
else
  echo "⚠️  includes.sh not found at $SUPPORT_DIR — checking against the bare PATH"
fi

echo "========================================"
echo " 🛠  RaidX | Ensure Build Requirements"
echo "========================================"

# "<command>:<brew formula>" — extend this line to add an auto-installed tool.
BREW_REQUIRED="pod:cocoapods xcbeautify:xcbeautify"

MISSING_FORMULAE=""
MISSING_MANUAL=""

# ================================
# 1️⃣ Xcode CLI tools
# ================================
if xcode-select -p >/dev/null 2>&1; then
  echo "✅ Xcode CLI tools: $(xcode-select -p)"
else
  echo "❌ Xcode CLI tools missing"
  MISSING_MANUAL="${MISSING_MANUAL}  • Xcode CLI tools — xcode-select --install"$'\n'
fi

# ================================
# 2️⃣ Tools we can install ourselves
# ================================
for pair in $BREW_REQUIRED; do
  cmd="${pair%%:*}"
  formula="${pair##*:}"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "✅ $cmd: $("$cmd" --version 2>/dev/null | head -n1)"
  else
    echo "❌ $cmd missing (brew formula: $formula)"
    MISSING_FORMULAE="${MISSING_FORMULAE}${formula} "
  fi
done

# ================================
# 3️⃣ Tools a human has to deal with
# ================================
for cmd in node npm git; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "✅ $cmd: $("$cmd" --version 2>/dev/null | head -n1) ($(command -v "$cmd"))"
  else
    case "$cmd" in
      node) hint="install Node on the host (nvm install --lts, or brew install node)" ;;
      npm)  hint="ships with Node — fix Node first" ;;
      *)    hint="xcode-select --install" ;;
    esac
    echo "❌ $cmd missing"
    MISSING_MANUAL="${MISSING_MANUAL}  • ${cmd} — ${hint}"$'\n'
  fi
done

# ================================
# 4️⃣ Install what's missing
# ================================
if [ -n "$MISSING_FORMULAE" ]; then
  if [ "$CHECK_ONLY_MODE" = "true" ]; then
    echo ""
    echo "ℹ️  --check: would install →${MISSING_FORMULAE% }"
  else
    if ! command -v brew >/dev/null 2>&1; then
      echo ""
      echo "❌ Homebrew is required to install:${MISSING_FORMULAE% }"
      echo "   Install it with:"
      echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      exit 1
    fi
    echo ""
    echo "📦 Installing:${MISSING_FORMULAE% }"
    # Word-splitting is the point here — one brew invocation for all formulae.
    # shellcheck disable=SC2086
    brew install ${MISSING_FORMULAE}
    # bash caches command lookups; without this the freshly installed binaries
    # stay "not found" for the verification below.
    hash -r

    echo ""
    echo "🔁 Verifying installs..."
    STILL_MISSING=""
    for pair in $BREW_REQUIRED; do
      cmd="${pair%%:*}"
      if command -v "$cmd" >/dev/null 2>&1; then
        echo "✅ $cmd: $("$cmd" --version 2>/dev/null | head -n1)"
      else
        echo "❌ $cmd still not on PATH after install"
        STILL_MISSING="${STILL_MISSING}${cmd} "
      fi
    done
    if [ -n "$STILL_MISSING" ]; then
      echo ""
      echo "❌ Installed, but not visible on this PATH: ${STILL_MISSING% }"
      echo "   PATH: $PATH"
      exit 1
    fi
  fi
fi

# ================================
# 5️⃣ Report anything left for a human
# ================================
if [ -n "$MISSING_MANUAL" ]; then
  echo ""
  echo "⚠️  Still missing (not installed automatically):"
  printf '%s' "$MISSING_MANUAL"
  echo "   Builds will fail until these are resolved on the build host."
  echo "   PATH: $PATH"
  # Deliberately not a failure: the deploy that called us still succeeded, and
  # these need a decision from a person rather than a retry.
elif [ "$CHECK_ONLY_MODE" = "true" ] && [ -n "$MISSING_FORMULAE" ]; then
  echo ""
  echo "⚠️  --check only — rerun without --check to install the above."
else
  echo ""
  echo "🎉 Build host has everything the iOS pipeline needs."
fi

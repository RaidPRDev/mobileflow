#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IS_DARWIN=$([ -x "$(command -v sw_vers)" ] && echo true || echo false)
if [ "$IS_DARWIN" = true ]; then
  RAID_X_HOME="$HOME/RaidX"
else
  # fun.sh is inside RaidX/Tools, so go up 1 level to RaidX
  RAID_X_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ================================
# SOURCE ENVIRONMENT
# ================================
ENV_FILE="$RAID_X_HOME/../.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "❌ .env not found at $ENV_FILE"
  exit 1
fi

GLOBALS_FILE="$RAID_X_HOME/Tools/ios/Support/globals.sh"
# shellcheck source=/dev/null
source "$GLOBALS_FILE"


# Animate dots around a rectangle while a background job runs
# rectangle_progress() {
#   local pid=$1
#   local frames=(
#     "[●     ]"  # left top
#     "[ ●    ]"
#     "[  ●   ]"
#     "[   ●  ]"
#     "[    ● ]"  # right top
#     "[     ●]"
#     "[    ● ]"
#     "[   ●  ]"
#     "[  ●   ]"
#     "[ ●    ]"  # left bottom
#   )

#   while kill -0 $pid 2>/dev/null; do
#     for frame in "${frames[@]}"; do
#       printf "\r%s" "$frame"
#       sleep 0.2
#       # break early if process finished mid-loop
#       kill -0 $pid 2>/dev/null || break
#     done
#   done
#   printf "\r[ Done ]\n"
# }

# Example: run sshpass scp in background
# sshpass -p "mypassword" scp file.txt user@remote:/path/ &
sleep 5 &

pid=$!
spinner_progress $pid uploading project
wait $pid
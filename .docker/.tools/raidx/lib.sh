#!/bin/bash

# lib.sh

set -e

# RaidX Scripts
if [[ -z "$SHARED_DIR" ]]; then
    echo "🌐 LIB Environment | SHARED_DIR is empty"
    exit 1
fi

# echo "🌐 LIB Environment:"
# echo "  🔹 SHARED_DIR=$SHARED_DIR"

source "$SHARED_DIR/utils/timers.sh"
source "$SHARED_DIR/utils/visual_loaders.sh"
source "$SHARED_DIR/utils/general.sh"
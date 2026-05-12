#!/bin/bash
set -euo pipefail

echo "==========================================="
echo " 🛠️  RaidX | Init Scripts"
echo "==========================================="

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔧 Making all scripts in $LOCAL_DIR executable..."

# Find all .sh files and chmod +x
find "$LOCAL_DIR" -type f -name "*.sh" -exec chmod +x {} \;

# Validate Scripts
cd "${LOCAL_DIR}/Support"

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
find "$LOCAL_DIR" -type f -name "*.sh" -exec chmod +x {} \;

# Validate Support/Scripts
cd "${LOCAL_DIR}/Scripts"

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
find "$LOCAL_DIR" -type f -name "*.sh" -exec chmod +x {} \;

echo "🔧 All scripts are ready!"
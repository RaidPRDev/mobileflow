#!/bin/bash
set -euo pipefail

clear

echo 'export PATH="$HOME/RaidX/Tools:$PATH"' >> ~/.zshrc
source ~/.zshrc

echo 'export PATH="$HOME/RaidX/Tools:$PATH"' >> ~/.bash_profile
source ~/.bash_profile

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔧 Making all scripts in $TOOLS_DIR executable..."

# Find all .sh files and chmod +x
find "$TOOLS_DIR" -type f -name "*.sh" -exec chmod +x {} \;

echo "✅ All scripts in tools/ are now executable."

echo
echo "📂 Contents of $TOOLS_DIR:"
ls -l "$TOOLS_DIR"

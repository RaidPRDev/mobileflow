#!/bin/bash
set -euo pipefail

# deploy_fileserver.sh
# One-time setup: deploys the xbuilds file server to Docker Swarm
# Run this on the cloud server or via SSH from the build script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📦 Deploying xbuilds file server..."

# Create downloads directory if not exists
mkdir -p /root/RaidX/downloads

# Deploy stack
docker stack deploy -c "$SCRIPT_DIR/xbuilds.yml" xbuilds

echo "✅ xbuilds file server deployed!"
echo "🌐 https://xbuilds.raidpr.com"

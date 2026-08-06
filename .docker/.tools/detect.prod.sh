#!/usr/bin/env bash
set -euo pipefail

# detect.prod.sh
# Runs on the CLOUD SERVER. Waits for the new stack to answer on its public URL.

set -a
source ../.docker/.config.env.tools
set +a

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_subheader "🛠️  [4/5] Testing [$URL_NAME]"

echo "🌐 Environment"
echo "  🔹 MODE=production"
echo "  🔹 URL_NAME=$URL_NAME"
new_line

SLEEP=5        # seconds between attempts
TIMEOUT=10     # curl max time per attempt
# The api task runs schema push + seed before it serves, and Let's Encrypt may
# be issuing a certificate on the very first deploy, so give it real time —
# but bounded, or a broken deploy leaves this loop (and the admin's log stream)
# running forever.
MAX_ATTEMPTS=120

echo "Waiting for [$URL_NAME] to become reachable..."
new_line

attempt=0
while true; do
  attempt=$((attempt + 1))
  status=$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w "%{http_code}" "$URL_NAME" || echo "000")

  if [[ $status =~ ^2|^3 ]]; then
    echo "$(date +"%Y-%m-%d %H:%M:%S")  OK — $URL_NAME responded with HTTP $status"
    break
  fi

  if (( attempt >= MAX_ATTEMPTS )); then
    echo "$(date +"%Y-%m-%d %H:%M:%S")  ❌ $URL_NAME never responded (last HTTP $status) after $attempt attempts."
    new_line
    echo "Service state:"
    docker stack services "$STACK_NAME" || true
    new_line
    echo "Recent api logs:"
    docker service logs --tail 80 "${STACK_NAME}_api" 2>&1 || true
    exit 1
  fi

  echo "$(date +"%Y-%m-%d %H:%M:%S")  no response (HTTP $status). Retrying in ${SLEEP}s... [$attempt/$MAX_ATTEMPTS]"
  sleep "$SLEEP"
done

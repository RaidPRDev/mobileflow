#!/usr/bin/env bash
set -euo pipefail

# teardown.crossx.sh
# Removes the OLD crossx stack (the RaidXAppBuilder PHP app at
# crossx.raidpr.com) that Caimón replaces. Deliberately NOT part of the deploy
# pipeline: it destroys a running service and, with --volumes, its MariaDB data.
#
# Run it ON THE CLOUD SERVER, by hand, once Caimón is verified:
#
#   ssh -i <key> root@89.117.17.43
#   bash /root/dev/raidpr.com/apps/caimon/.docker/.tools/teardown.crossx.sh          # dry run
#   bash /root/dev/raidpr.com/apps/caimon/.docker/.tools/teardown.crossx.sh --yes    # remove stack
#   bash .../teardown.crossx.sh --yes --volumes                                      # also drop raid_db_data
#
# The stack's services are builder_app, builder_connect_db, builder_phpmyadmin;
# its data lives in the `raid_db_data` volume. Back that up first if the
# builder's MariaDB contents still matter — once the volume is gone it is gone.

OLD_STACK="crossx"
OLD_VOLUME="raid_db_data"
OLD_PATH="/root/dev/raidpr.com/apps/crossx"
BACKUP_DIR="/root/dev/crossx-final-backup"

CONFIRM=0
DROP_VOLUMES=0
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRM=1 ;;
    --volumes) DROP_VOLUMES=1 ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

echo "📋 Current state of [$OLD_STACK]:"
docker stack services "$OLD_STACK" 2>/dev/null || echo "  (stack not deployed)"
echo
docker volume ls --filter "name=${OLD_VOLUME}" || true
echo

if [[ "$CONFIRM" != "1" ]]; then
  echo "ℹ️  Dry run. Nothing was removed."
  echo "   Re-run with --yes to remove the stack, and --volumes to also drop"
  echo "   the ${OLD_VOLUME} volume (irreversible)."
  exit 0
fi

# A final dump of the builder's MariaDB before anything is torn down. Best
# effort: an already-dead container is not a reason to block the teardown, but
# a reachable one should never be dropped undumped.
DB_CID="$(docker ps --filter "label=com.docker.swarm.service.name=${OLD_STACK}_builder_connect_db" --format '{{.ID}}' | head -n1)"
if [[ -n "$DB_CID" ]]; then
  mkdir -p "$BACKUP_DIR"
  OUT="${BACKUP_DIR}/crossx_$(date +%Y%m%d_%H%M%S).sql.gz"
  echo "📦 Final dump of the crossx database → $OUT"
  docker exec "$DB_CID" sh -lc 'mysqldump -u root -p"$MARIADB_ROOT_PASSWORD" --all-databases' \
    | gzip > "$OUT" || echo "  ⚠️  dump failed — continuing (see $OUT)"
  ls -lh "$OUT" 2>/dev/null || true
else
  echo "ℹ️  No running crossx database container — skipping final dump."
fi

echo "🗑️  Removing stack [$OLD_STACK]"
docker stack rm "$OLD_STACK" || true

echo "⏳ Waiting for tasks and the overlay network to go away..."
for _ in $(seq 1 30); do
  if ! docker stack services "$OLD_STACK" >/dev/null 2>&1; then break; fi
  sleep 2
done
docker network prune -f >/dev/null 2>&1 || true

if [[ "$DROP_VOLUMES" == "1" ]]; then
  echo "🗑️  Removing volume [$OLD_VOLUME]"
  docker volume rm "$OLD_VOLUME" || echo "  ⚠️  could not remove $OLD_VOLUME (still in use?)"
else
  echo "ℹ️  Keeping volume [$OLD_VOLUME]. Re-run with --volumes to drop it."
fi

echo "🧹 Pruning the old builder images"
docker images 'localhost:5005/raidpr_app_builder' --format '{{.ID}}' \
  | xargs -r docker rmi -f >/dev/null 2>&1 || true

if [[ -d "$OLD_PATH" ]]; then
  echo "ℹ️  Build directory still on disk: $OLD_PATH"
  echo "   Remove it with: rm -rf $OLD_PATH"
fi

echo "✅ crossx removed. Point DNS for crossx.raidpr.com wherever you like —"
echo "   Traefik no longer has a router for it."

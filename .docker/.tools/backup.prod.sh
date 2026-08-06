#!/usr/bin/env bash
set -euo pipefail

# backup.prod.sh
# Runs on the CLOUD SERVER, BEFORE deploy.prod.sh applies the new stack — and
# therefore before the new api task pushes the schema on boot. Takes a
# compressed pg_dump of the running Postgres so a bad schema change can be
# undone. Skips cleanly on the first-ever deploy (no db service yet).

set -a
source ../.docker/.config.env.tools
set +a

# RaidX Scripts
source "$SHARED_DIR/${SCRIPTS_INCLUDE}"

set_subheader "🛟  [2/5] Backing up Postgres before deploy"

echo "🌐 Environment"
echo "  🔹 STACK_NAME=$STACK_NAME"
echo "  🔹 BACKUP_DIR=$BACKUP_DIR"
echo "  🔹 BACKUP_KEEP=$BACKUP_KEEP"
echo "  🔹 DB_USER=$DB_USER / DB_NAME=$DB_NAME"
new_line

# The running Postgres task container for this stack's db service.
DB_CID="$(docker ps \
  --filter "label=com.docker.swarm.service.name=${STACK_NAME}_db" \
  --format '{{.ID}}' | head -n1)"

if [[ -z "$DB_CID" ]]; then
  echo "ℹ️  No running [${STACK_NAME}_db] container found — first deploy or db down."
  echo "ℹ️  Skipping backup (nothing to dump)."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/${DB_NAME}_${STAMP}.sql.gz"

echo "📦 Dumping [$DB_NAME] from container [$DB_CID] → $OUT"
# pg_dump streams out of the container; gzip on the host. `set -e` + pipefail
# abort the whole deploy if the dump fails, so we never migrate without one.
docker exec "$DB_CID" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "✅ Backup complete ($SIZE): $OUT"
new_line

echo "🧹 Rotating backups (keeping newest $BACKUP_KEEP)"
ls -1t "${BACKUP_DIR}/${DB_NAME}_"*.sql.gz 2>/dev/null \
  | tail -n +"$((BACKUP_KEEP + 1))" \
  | while read -r old; do
      echo "  🗑️  removing $old"
      rm -f "$old"
    done

echo "✅ Backup step done."
new_line

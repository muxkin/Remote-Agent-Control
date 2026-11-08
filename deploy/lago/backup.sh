#!/bin/sh
set -eu
umask 077
cd /opt/lago
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
stage=$(mktemp -d "backups/.${stamp}.XXXXXX")
trap 'rm -rf "$stage"' EXIT
docker compose exec -T db pg_dump -U lago -d lago -Fc > "$stage/postgres.dump"
docker compose exec -T db pg_restore --list < "$stage/postgres.dump" > /dev/null
docker compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --rdb /data/backup.rdb >/dev/null 2>&1'
docker compose exec -T redis cat /data/backup.rdb > "$stage/redis.rdb"
docker compose exec -T redis rm /data/backup.rdb
docker compose exec -T api tar -C /app/storage -czf - . > "$stage/storage.tar.gz"
cp .env compose.yaml "$stage/"
for config in compose.override.yaml image-digests.json Caddyfile; do
    if [ -f "$config" ]; then cp "$config" "$stage/"; fi
done
mv "$stage" "backups/lago-${stamp}"
trap - EXIT
python3 - <<'PY'
from pathlib import Path
import shutil
import time
cutoff = time.time() - 14 * 86400
for path in Path('backups').glob('lago-*'):
    if path.is_dir() and not path.is_symlink() and path.stat().st_mtime < cutoff:
        shutil.rmtree(path)
PY
printf 'Lago backup completed: %s\n' "$stamp"

#!/usr/bin/env bash
# Daily Postgres dump of the mobilapp database. Keeps 14 days. Cron (gotunc): 30 3 * * * /home/mkati/mobilapp/scripts/backup.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/backups"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d_%H%M%S)"
sudo docker exec mobilapp-db pg_dump -U mobilapp -d mobilapp --no-owner | gzip > "$OUT/mobilapp_$STAMP.sql.gz"
find "$OUT" -name 'mobilapp_*.sql.gz' -mtime +14 -delete
echo "backup written: $OUT/mobilapp_$STAMP.sql.gz"

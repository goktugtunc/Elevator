#!/usr/bin/env bash
# Dev loop helper: runs tooling inside the api image with the working tree live-mounted.
#   scripts/dev.sh test [pytest args]     -> pytest against the mobilapp_test database
#   scripts/dev.sh ruff [args]            -> ruff check app tests scripts (default)
#   scripts/dev.sh alembic <args>         -> e.g. alembic revision --autogenerate -m "init"
#   scripts/dev.sh py <module or file>    -> python ...
#   scripts/dev.sh shell                  -> bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
set -a; # shellcheck disable=SC1091
source .env; set +a
NET=mobilapp_mobilapp_net
sudo docker compose up -d db >/dev/null 2>&1
CMD="${1:-ruff}"; shift || true
run() {
  sudo docker run --rm -i --user "$(id -u):$(id -g)" -v "$DIR":/app -w /app --network "$NET" \
    --env-file .env -e HOME=/tmp -e LIVE_STELLAR="${LIVE_STELLAR:-}" \
    -e DATABASE_URL="postgresql+asyncpg://mobilapp:${POSTGRES_PASSWORD}@db:5432/mobilapp" \
    -e DATABASE_URL_TEST="postgresql+asyncpg://mobilapp:${POSTGRES_PASSWORD}@db:5432/mobilapp_test" \
    "$@"
}
case "$CMD" in
  test)    run -e APP_ENV=test --entrypoint pytest mobilapp-api:latest -q "$@" ;;
  ruff)    if [ $# -eq 0 ]; then set -- check app tests scripts; fi; run --entrypoint ruff mobilapp-api:latest "$@" ;;
  alembic) run --entrypoint alembic mobilapp-api:latest "$@" ;;
  py)      run --entrypoint python mobilapp-api:latest "$@" ;;
  shell)   sudo docker run --rm -it --user "$(id -u):$(id -g)" -v "$DIR":/app -w /app --network "$NET" --env-file .env -e HOME=/tmp --entrypoint bash mobilapp-api:latest ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac

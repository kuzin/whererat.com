#!/usr/bin/env bash
# Throwaway local Postgres for the Playwright suite (never touches a real database).
#
#   scripts/e2e-db.sh start|stop|status|url
#
# Uses Homebrew/system Postgres binaries when present, otherwise Docker.
set -euo pipefail

PORT="${E2E_DB_PORT:-54330}"
DB="whererat_e2e"
USER_NAME="e2e"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.e2e/pg"
SOCK="/tmp/whererat-e2e-pg"
CONTAINER="whererat-e2e-pg"
URL="postgresql://$USER_NAME@127.0.0.1:$PORT/$DB?sslmode=disable"

find_bin() {
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"; return; fi
  for d in /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin /usr/lib/postgresql/*/bin; do
    [ -x "$d/$1" ] && { echo "$d/$1"; return; }
  done
  return 1
}

ready() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

start_local() {
  local initdb pg_ctl psql createdb
  initdb="$(find_bin initdb)"; pg_ctl="$(find_bin pg_ctl)"; psql="$(find_bin psql)"; createdb="$(find_bin createdb)"
  mkdir -p "$SOCK" "$ROOT/.e2e"
  [ -d "$DATA" ] || "$initdb" -D "$DATA" -U "$USER_NAME" --auth=trust >/dev/null
  "$pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" -l "$ROOT/.e2e/pg.log" -w start >/dev/null
  "$psql" -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d postgres -Atc "select 1 from pg_database where datname='$DB'" | grep -q 1 \
    || "$createdb" -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" "$DB"
}

start_docker() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:5432" \
    -e POSTGRES_USER="$USER_NAME" -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$DB" postgres:16 >/dev/null
  for _ in $(seq 1 30); do ready && return; sleep 1; done
}

case "${1:-}" in
  start)
    if ready; then echo "already running on :$PORT"; exit 0; fi
    if find_bin initdb >/dev/null 2>&1; then start_local; elif command -v docker >/dev/null 2>&1; then start_docker; else
      echo "Need Postgres binaries (brew install postgresql@16) or Docker." >&2; exit 1
    fi
    echo "Postgres for e2e is up: $URL" ;;
  stop)
    if find_bin pg_ctl >/dev/null 2>&1 && [ -d "$DATA" ]; then "$(find_bin pg_ctl)" -D "$DATA" -m fast stop >/dev/null 2>&1 || true; fi
    command -v docker >/dev/null 2>&1 && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "stopped" ;;
  status) ready && echo "running on :$PORT" || { echo "not running"; exit 1; } ;;
  url) echo "$URL" ;;
  *) echo "usage: $0 start|stop|status|url" >&2; exit 2 ;;
esac

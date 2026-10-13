#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p work/pg
if [[ -z "${WEAVE_PG_BIN:-}" ]]; then
  if command -v pg_ctl >/dev/null 2>&1; then WEAVE_PG_BIN="$(dirname "$(command -v pg_ctl)")";
  elif command -v mise >/dev/null 2>&1; then WEAVE_PG_BIN="$(mise where postgres)/bin";
  else echo 'Install PostgreSQL 17+ or set WEAVE_PG_BIN to its bin directory.' >&2; exit 1; fi
fi
WEAVE_PG_PORT="${WEAVE_PG_PORT:-55439}"
if [[ ! -f work/pg/data/PG_VERSION ]]; then "$WEAVE_PG_BIN/initdb" -D work/pg/data --auth=trust --username=weave > work/pg/init.log; fi
if ! "$WEAVE_PG_BIN/pg_ctl" -D work/pg/data status >/dev/null 2>&1; then
  "$WEAVE_PG_BIN/pg_ctl" -D work/pg/data -l "$PWD/work/pg/server.log" -o "-h 127.0.0.1 -p $WEAVE_PG_PORT" start
fi
if ! "$WEAVE_PG_BIN/psql" -h 127.0.0.1 -p "$WEAVE_PG_PORT" -U weave postgres -tAc "SELECT 1 FROM pg_database WHERE datname='weave'" | grep -q 1; then
  "$WEAVE_PG_BIN/createdb" -h 127.0.0.1 -p "$WEAVE_PG_PORT" -U weave weave
fi
echo "Local PostgreSQL ready on port $WEAVE_PG_PORT. Run pnpm dev."

#!/usr/bin/env bash
# Starts a local PostgreSQL 16 for authorization/integration tests (Debian/Ubuntu cluster layout).
# Tests read DATABASE_URL (default postgres://postgres:postgres@127.0.0.1:5432/postgres).
set -euo pipefail
if command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_ctlcluster 16 main start 2>/dev/null || true
  su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres';\"" >/dev/null
  pg_isready -h 127.0.0.1 -p 5432
else
  echo "pg_ctlcluster not found. Run: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16" >&2
  exit 1
fi

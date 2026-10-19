#!/usr/bin/env bash
# Regenerates docs/schema/schema.sql: the complete DDL the 44 migrations produce, with NO data.
#
# WHY A COMMITTED DUMP. An external reviewer can read the whole schema — every table, constraint,
# index, function, trigger and RLS policy — without any database credential at all. That is the
# least-privilege answer to "I need to understand the database": nobody needs access to a hosted
# project to read a structure, and this repository's hosted project is empty anyway.
#
# It is a DERIVED artifact. supabase/migrations/ is the source of truth; this is what they build.
# Regenerate it after any migration, in the same commit, or it becomes a second copy that drifts
# (the failure this repository has recorded four times: BUG-411, BUG-426, BUG-430, BUG-432).
#
#   scripts/dump-schema.sh            # builds a scratch database, dumps, writes docs/schema/schema.sql
#   DATABASE_URL=... scripts/dump-schema.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
SCRATCH="pl_schema_dump_$$"
ADMIN="${BASE%/*}/postgres"
TARGET="${BASE%/*}/${SCRATCH}"

cleanup() { psql "$ADMIN" -q -c "drop database if exists ${SCRATCH} with (force);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$ADMIN" -q -c "drop database if exists ${SCRATCH} with (force);"
psql "$ADMIN" -q -c "create database ${SCRATCH};"
# The Supabase platform shim first: it provides the auth schema and roles the migrations reference.
# It is TEST SCAFFOLDING, not product schema, which is why the dump below names only our three.
psql "$TARGET" -q -v ON_ERROR_STOP=1 -f supabase/tests/shim/supabase_platform_shim.sql
DATABASE_URL="$TARGET" pnpm --filter @pencillift/db run migrate

mkdir -p docs/schema
{
  echo "-- PencilLift database schema — STRUCTURE ONLY, no rows, no credentials."
  echo "--"
  echo "-- DERIVED. Source of truth is supabase/migrations/ (44 files). This is what they produce when"
  echo "-- applied in order to an empty database, dumped from schemas public, private and app only."
  echo "-- Regenerate with scripts/dump-schema.sh after any migration, in the same commit."
  echo "--"
  echo "-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) from commit $(git rev-parse --short HEAD)"
  echo "-- Migrations applied: $(ls supabase/migrations/*.sql | wc -l | tr -d ' ')"
  echo "--"
  echo "-- The auth schema is NOT here. It belongs to Supabase Auth; what the application expects of"
  echo "-- it is documented in docs/Database_Schema.md, and supabase/tests/shim/ emulates it for tests."
  echo
  # `\restrict` carries a per-run random token and is pg_dump session scaffolding, not schema.
  pg_dump "$TARGET" --schema-only --no-owner --no-privileges -n public -n private -n app \
    | grep -vE '^\\(un)?restrict ' \
    | grep -vE '^-- Dumped (from|by) '
} > docs/schema/schema.sql

lines=$(wc -l < docs/schema/schema.sql)
if grep -qE '^(COPY |INSERT )' docs/schema/schema.sql; then
  echo "::error::the dump contains data statements; refusing" >&2; exit 1
fi
echo "docs/schema/schema.sql: ${lines} lines, structure only"

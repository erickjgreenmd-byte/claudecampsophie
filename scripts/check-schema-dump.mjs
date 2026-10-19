#!/usr/bin/env node
/**
 * Guards `docs/schema/schema.sql` against the drift that makes a derived document worse than no
 * document: a migration lands, the dump is not regenerated, and a reviewer reads a schema that no
 * longer exists. Regenerating needs a live Postgres; checking does not, so this runs in every gate.
 *
 *   node scripts/check-schema-dump.mjs
 *
 * Three checks, all mechanical (lesson L-084):
 *   1. The header's migration count equals the number of files in supabase/migrations.
 *   2. The set of tables the dump creates equals the set the migrations create — the check that
 *      actually catches a forgotten regeneration, since a new migration almost always adds a table.
 *   3. No data statements. The dump is published to people outside the project and must never carry
 *      a row (CLAUDE.md: no real child data in docs).
 *
 * It is deliberately not a line-by-line comparison against a fresh dump: pg_dump output varies with
 * server version, and a check that cries wolf on PostgreSQL 16 vs 17 would be turned off.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dumpPath = 'docs/schema/schema.sql';
const dump = readFileSync(join(repo, dumpPath), 'utf8');

const migrationFiles = readdirSync(join(repo, 'supabase/migrations')).filter((f) =>
  f.endsWith('.sql'),
);
const problems = [];

// 1. header count
const declared = /^-- Migrations applied: (\d+)$/m.exec(dump);
if (declared === null) {
  problems.push('the header has no "Migrations applied: N" line');
} else if (Number(declared[1]) !== migrationFiles.length) {
  problems.push(
    `header says ${declared[1]} migrations, supabase/migrations holds ${migrationFiles.length} — regenerate with scripts/dump-schema.sh`,
  );
}

// 2. table sets
const migrationSql = migrationFiles
  .map((f) => readFileSync(join(repo, 'supabase/migrations', f), 'utf8'))
  .join('\n');
const created = new Set();
for (const m of migrationSql.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(public|private|app)\.([a-z_]+)/gi,
)) {
  created.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
}
const dumped = new Set();
for (const m of dump.matchAll(/^CREATE TABLE (public|private|app)\.([a-z_]+)/gm)) {
  dumped.add(`${m[1]}.${m[2]}`);
}
const missing = [...created].filter((t) => !dumped.has(t)).sort();
const extra = [...dumped].filter((t) => !created.has(t)).sort();
if (missing.length > 0) {
  problems.push(
    `the migrations create ${missing.length} table(s) the dump does not have (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) — regenerate with scripts/dump-schema.sh`,
  );
}
if (extra.length > 0) {
  problems.push(
    `the dump has ${extra.length} table(s) no migration creates (${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}) — a migration was removed without regenerating, or the dump is hand-edited`,
  );
}

// 3. no rows
const dataLines = dump.split('\n').filter((l) => /^(COPY |INSERT )/.test(l));
if (dataLines.length > 0)
  problems.push(`${dataLines.length} data statement(s) in a structure-only dump`);

if (problems.length > 0) {
  console.error(`✗ ${dumpPath}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ ${dumpPath}: ${dumped.size} tables, ${migrationFiles.length} migrations, no rows`);

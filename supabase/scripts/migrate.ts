import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Ordered migration file names (lexicographic, matching Supabase CLI ordering). */
export async function listMigrations(dir = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/** Applies every migration in order inside one transaction per file. */
export async function applyMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied: string[] = [];
  for (const name of await listMigrations(dir)) {
    const text = await readFile(path.join(dir, name), 'utf8');
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error });
    }
    applied.push(name);
  }
  return applied;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required to apply migrations.');
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const applied = await applyMigrations(sql);
    console.log(`Applied ${applied.length} migrations.`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

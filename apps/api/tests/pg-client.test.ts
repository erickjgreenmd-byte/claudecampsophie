import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@pencillift/db/testing';
import { createPostgresClient } from '../src/pg-client.ts';

/**
 * BUG-063: the Worker's client was built with `fetch_types: false`, so every JavaScript array
 * parameter failed in production with "malformed array literal" while the tests (default options)
 * passed. These checks run through the production client factory.
 */
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.drop();
});

describe('the production Postgres client binds array parameters (BUG-063)', () => {
  it('uuid[], text[] and int[] parameters work in casts, any() and all()', async () => {
    const sql = createPostgresClient(db.url, { max: 1 });
    try {
      const ids = ['8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60', '9b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f61'];
      const [row] = await sql<
        { cast: string[]; anyText: boolean; allUuid: boolean; ints: number[] }[]
      >`
        select ${ids}::uuid[] as cast,
               'b' = any(${['a', 'b']}) as "anyText",
               ${ids[0]!}::uuid <> all(${ids}::uuid[]) as "allUuid",
               ${[1, 2, 3]}::int[] as ints`;
      expect(row).toEqual({ cast: ids, anyText: true, allUuid: false, ints: [1, 2, 3] });
    } finally {
      await sql.end();
    }
  });

  it('API source builds Postgres clients only through createPostgresClient', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
      });
    const offenders = files(src).filter(
      (file) => !file.endsWith('pg-client.ts') && /\bpostgres\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

import postgres, { type Sql } from 'postgres';

/**
 * The API's one Postgres client configuration. The Worker (src/index.ts, through Hyperdrive) and
 * every API test (tests/helpers.ts) build their client here, so tests run with production options.
 *
 * Decision: `fetch_types` stays on (the postgres.js default). With it off, postgres.js cannot
 * serialize JavaScript arrays, and every array parameter (`${ids}::uuid[]`, `= any(${list})`) fails
 * with "malformed array literal"; the API binds arrays in 30+ places (BUG-063). Cloudflare suggests
 * turning it off only for schemas without array types. The cost is one type query per connection.
 * `prepare: false` keeps statements unnamed, which Hyperdrive's pooling requires.
 */
export function createPostgresClient(
  url: string,
  options: { readonly max?: number; readonly onnotice?: () => void } = {},
): Sql {
  return postgres(url, {
    max: options.max ?? 5,
    prepare: false,
    ...(options.onnotice ? { onnotice: options.onnotice } : {}),
  });
}

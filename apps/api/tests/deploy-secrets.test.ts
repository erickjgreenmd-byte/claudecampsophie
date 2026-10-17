import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

/**
 * THE DEPLOY PATH MUST BE ABLE TO START THE WORKER.
 *
 * `.github/workflows/deploy-api.yml` set SUPABASE_JWKS_URL and SUPABASE_JWT_ISSUER and nothing else,
 * while `loadConfig` also requires CHILD_TOKEN_SECRET and HASH_PEPPER (`secretBytes`, ≥32
 * characters) and neither is in `wrangler.toml`. The Worker it deployed therefore answered
 * 503 NOT_CONFIGURED on EVERY path, `/health` included, and the workflow's own probe printed that
 * as the testbed working. Every suite was green, because no test had ever asked the question this
 * file asks.
 *
 * It is deliberately BEHAVIOURAL rather than a grep for names: it builds the environment the deploy
 * path actually produces — the `[env.<name>.vars]` table from wrangler.toml plus every name the
 * workflow runs `wrangler secret put` on — and then calls the real `loadConfig`. A name added to
 * the config and forgotten in the deploy fails here, and the failure NAMES it, because that is what
 * `loadConfig` already does. A grep would have to be taught each new name; this does not (L-074:
 * the question is whether anything can actually call it).
 */
const REPO = join(import.meta.dirname, '..', '..', '..');
const WRANGLER = readFileSync(join(REPO, 'apps/api/wrangler.toml'), 'utf8');
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/deploy-api.yml'), 'utf8');

/** The `[env.<name>.vars]` table, as wrangler would apply it. */
function varsFor(environment: string): Record<string, string> {
  const vars: Record<string, string> = {};
  let inTable = false;
  for (const raw of WRANGLER.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inTable = header[1] === `env.${environment}.vars`;
      continue;
    }
    const pair = inTable ? /^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line) : null;
    if (pair?.[1]) vars[pair[1]] = pair[2] ?? '';
  }
  return vars;
}

/** Every name the workflow sets with `wrangler secret put`, in the order it sets them. */
function secretsSetByWorkflow(): string[] {
  const direct = [...WORKFLOW.matchAll(/wrangler secret put ([A-Z0-9_]+)/g)].map((m) => m[1]!);
  // `set_secret NAME "..."` is the helper that puts the two signing secrets.
  const viaHelper = [...WORKFLOW.matchAll(/^\s*set_secret ([A-Z0-9_]+)/gm)].map((m) => m[1]!);
  return [...new Set([...direct, ...viaHelper])].filter((n) => n !== '$name');
}

/**
 * A value of the shape that name carries. The two URL-ish names get the URLs the workflow derives
 * from the project ref; everything else gets 64 hex characters, which clears the ≥32 floor.
 */
function valueFor(name: string): string {
  if (name.endsWith('_JWKS_URL'))
    return 'https://example.supabase.co/auth/v1/.well-known/jwks.json';
  if (name.endsWith('_ISSUER')) return 'https://example.supabase.co/auth/v1';
  return 'a'.repeat(64);
}

function deployEnvironmentFor(environment: string): Record<string, string> {
  const env = { ...varsFor(environment) };
  for (const name of secretsSetByWorkflow()) env[name] = valueFor(name);
  return env;
}

describe('the environment deploy-api.yml produces is one the Worker can start in', () => {
  it('sets both signing secrets, which is what it used to omit', () => {
    // Pinned by name as well as by the behavioural check below: these two are the ones whose
    // absence produced a 503 on every path, and a regression that dropped them while adding some
    // other secret would still satisfy "loadConfig succeeds" if the other happened to be enough.
    expect(secretsSetByWorkflow()).toEqual(
      expect.arrayContaining(['CHILD_TOKEN_SECRET', 'HASH_PEPPER']),
    );
  });

  it.each(['testbed', 'staging', 'production'])(
    'loadConfig succeeds for env.%s with exactly what the deploy supplies',
    (environment) => {
      const env = deployEnvironmentFor(environment);
      // A guard over an empty set passes (L-054): prove the parsing found something first.
      expect(
        Object.keys(env).length,
        'nothing was parsed out of the toml or the workflow',
      ).toBeGreaterThan(3);
      expect(env.APP_ENV, `env.${environment}.vars must set APP_ENV`).toBeDefined();

      const loaded = loadConfig(env);
      // The message names the missing variables, which is the whole point of reporting it this way.
      const problems = loaded.ok ? [] : loaded.errors.map((e) => `${e.name}: ${e.problem}`);
      expect(problems, `env.${environment} cannot start`).toEqual([]);
    },
  );

  it('a deploy that forgot a signing secret is caught, not tolerated', () => {
    // The mutation this file exists for, run as a case: drop HASH_PEPPER and loadConfig must refuse.
    const env = deployEnvironmentFor('testbed');
    delete env.HASH_PEPPER;
    const loaded = loadConfig(env);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.errors.map((e) => e.name)).toContain('HASH_PEPPER');
  });
});

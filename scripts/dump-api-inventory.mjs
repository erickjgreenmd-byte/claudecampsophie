#!/usr/bin/env node
/**
 * Derive docs/API_Inventory.md from apps/api/src — the HTTP surface, what authenticates each route
 * and where the handler lives. Derived, never hand-edited: regenerate it in the same commit as any
 * route change, and `--check` fails if it is stale.
 *
 *   node scripts/dump-api-inventory.mjs            # write docs/API_Inventory.md
 *   node scripts/dump-api-inventory.mjs --check    # fail if the file on disk is stale
 *
 * Mechanical rather than prose (lesson L-084): a hand-written endpoint list drifts the first time
 * someone adds a route, and a reviewer who finds one wrong entry stops trusting the rest.
 *
 * Middleware is not the whole story. The capture routes in homework.ts and both provider webhooks
 * authenticate INSIDE the handler, so a report that looked only at `r.use(...)` and the declaration
 * line called seven authenticated routes unauthenticated — a false security claim in a document
 * written to be trusted. This reads the handler body too, and anything it cannot account for is
 * listed as unauthenticated so the error falls on the side of over-reporting.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(repo, p), 'utf8');

const app = read('apps/api/src/app.ts');

// import { familyRoutes } from './routes/family.ts';
const importedFrom = new Map();
for (const m of app.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/routes\/([a-z-]+)\.ts'/g)) {
  for (const name of m[1].split(',')) {
    const clean = name.trim();
    if (clean !== '') importedFrom.set(clean, `apps/api/src/routes/${m[2]}.ts`);
  }
}

// app.route('/v1', familyRoutes());
const mounts = [];
for (const m of app.matchAll(/app\.route\('([^']*)',\s*([A-Za-z0-9_]+)\(\)\)/g)) {
  const file = importedFrom.get(m[2]);
  if (file === undefined) throw new Error(`mounted ${m[2]} is not imported from ./routes/`);
  mounts.push({ prefix: m[1] === '/' ? '' : m[1], file });
}
if (mounts.length === 0)
  throw new Error('found no app.route() mounts — the idiom in app.ts changed');

const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

/** Hono's `*` and `:param` patterns, as a predicate over concrete paths. */
function matcher(pattern) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = pattern
    .split('*')
    .map((part) =>
      part
        .split('/')
        .map((seg) => (seg.startsWith(':') ? '[^/]+' : escape(seg)))
        .join('/'),
    )
    .join('.*');
  const rx = new RegExp(`^${source}$`);
  return (path) => rx.test(path);
}

/**
 * The text of one `r.<method>(...)` call, from its opening paren to the matching close. Walks the
 * source rather than guessing at line ranges, skipping string, template and comment contents so a
 * paren inside a message or a regex cannot end the call early.
 */
function callAt(src, open) {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') {
      i += 1;
      let inner = 0;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          inner += 1;
          i += 2;
          continue;
        }
        if (src[i] === '}' && inner > 0) {
          inner -= 1;
          i += 1;
          continue;
        }
        if (src[i] === '`' && inner === 0) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i += 1;
  }
  throw new Error('unbalanced route declaration');
}

/** Middleware identifiers in the declaration's argument list, before the handler. */
const MIDDLEWARE = /\b(requireParent|requireChild|requireOwnerAdmin|commercialHeaders)\b/g;

/** Authentication performed inside the handler, keyed by the call that performs it. */
const IN_HANDLER = [
  ['resolveCaller(', 'resolveCaller'],
  ['verifyStripeSignature(', 'verifyStripeSignature'],
  ['constantTimeEquals(', 'constantTimeEquals'],
  ['assertOwnerAdmin(', 'assertOwnerAdmin'],
  ['assertRecentUnlock(', 'assertRecentUnlock'],
];

function routesIn(file) {
  const src = read(file);
  const lineOf = (index) => src.slice(0, index).split('\n').length;

  // r.use('/billing/*', requireParent) and r.use(path, requireParent, requireOwnerAdmin) — the
  // second form takes its path from a loop variable, so the guard covers every path that loop
  // walks. Recorded as matching everything in the file so no route there reads as unguarded.
  const uses = [];
  for (const line of src.split('\n')) {
    const literal = /\br\.use\('([^']*)'\s*,\s*([^)]*)\)/.exec(line);
    if (literal !== null) {
      uses.push({
        match: matcher(literal[1]),
        guards: [...literal[2].matchAll(MIDDLEWARE)].map((m) => m[1]),
      });
      continue;
    }
    const dynamic = /\br\.use\(\s*([A-Za-z0-9_]+)\s*,\s*([^)]*)\)/.exec(line);
    if (dynamic !== null) {
      uses.push({
        match: () => true,
        guards: [...dynamic[2].matchAll(MIDDLEWARE)].map((m) => m[1]),
      });
    }
  }

  const out = [];
  for (const method of METHODS) {
    const decl = new RegExp(`\\br\\.${method}\\('([^']*)'`, 'g');
    for (const m of decl.exec.length === 0 ? [] : src.matchAll(decl)) {
      const path = m[1];
      const call = callAt(src, m.index + m[0].length - path.length - 3);
      // The declaration's own arguments end where the handler begins; everything after `async (c)`
      // or `(c) =>` is body. Split there so a middleware name is never read out of the body.
      const handlerAt = call.search(/\basync\s*\(|\(c\)\s*=>/);
      const head = handlerAt === -1 ? call : call.slice(0, handlerAt);
      const body = handlerAt === -1 ? '' : call.slice(handlerAt);
      const middleware = [...head.matchAll(MIDDLEWARE)].map((x) => x[1]);
      const fromUse = uses.filter((u) => u.match(path)).flatMap((u) => u.guards);
      const inHandler = IN_HANDLER.filter(([needle]) => body.includes(needle)).map(
        ([, name]) => name,
      );
      out.push({
        method: method.toUpperCase(),
        path,
        guards: [...new Set([...fromUse, ...middleware])],
        inHandler,
        line: lineOf(m.index),
      });
    }
  }
  return out;
}

const rows = [];
for (const mount of mounts) {
  for (const r of routesIn(mount.file)) {
    rows.push({ ...r, path: `${mount.prefix}${r.path}`, source: `${mount.file}:${r.line}` });
  }
}
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const MEANING = {
  requireParent: 'middleware — adult bearer token (Supabase JWT); 401 without one',
  requireChild: 'middleware — child session token minted by `/v1/child/*`; 401 without one',
  requireOwnerAdmin: 'middleware — adult token **and** the owner-admin allow-list; 403 otherwise',
  commercialHeaders:
    'middleware, **not** an authorization guard — adds the commercial-disclosure headers',
  resolveCaller:
    'in-handler — accepts either an adult token or a paired child token, re-checks the child session in the database, and throws `UNAUTHENTICATED` without one',
  verifyStripeSignature: 'in-handler — Stripe webhook signature over the raw body',
  constantTimeEquals:
    'in-handler — constant-time comparison of a shared secret (the RevenueCat `Authorization` header)',
  assertOwnerAdmin: 'in-handler — owner-admin allow-list, on top of the route middleware',
  assertRecentUnlock: 'in-handler — step-up: the parent must have re-authenticated recently',
};

/** Routes this script can find nothing authenticating. Public by design, or a defect. */
const EXPECTED_PUBLIC = new Map([
  ['GET /health', 'Liveness. Says ready/not-ready and the environment; no family data.'],
  [
    'GET /v1/data-practices',
    'The data notice shown on pages nobody has signed in to. Publishes two enums derived from the gates, never the ZDR approval reference.',
  ],
  [
    'POST /v1/child/pair',
    'Establishes a child session from a pairing code and PIN. Cannot require a session it is issuing.',
  ],
  [
    'POST /v1/child/refresh',
    'Exchanges a child refresh token for an access token. The refresh token is the credential.',
  ],
]);

const unauthenticated = rows.filter((r) => r.guards.length === 0 && r.inHandler.length === 0);
const unexplained = unauthenticated.filter((r) => !EXPECTED_PUBLIC.has(`${r.method} ${r.path}`));

const out = [];
out.push('# PencilLift HTTP surface (derived)');
out.push('');
out.push(
  'Generated by `node scripts/dump-api-inventory.mjs` from `apps/api/src/app.ts` and',
  '`apps/api/src/routes/*.ts`. **Do not hand-edit** — regenerate it in the same commit as any route',
  'change.',
);
out.push('');
out.push(
  `${rows.length} routes across ${mounts.length} mounted modules. The "authenticated by" column is`,
  'what the code does — middleware named on the route or attached by an `r.use(...)` prefix, plus',
  'authentication performed inside the handler body. Nothing here is read from a comment or a doc.',
);
out.push('');
out.push(
  'Authorization does not stop there. Every request runs as a Postgres role (`pl_parent`, `pl_child`,',
  '`pl_service`) under row-level security, so a route that only proves "some parent" still cannot',
  'reach another family — see `docs/Access_And_Least_Privilege.md` and `docs/schema/schema.sql`.',
);
out.push('');
out.push('## What each check means');
out.push('');
out.push('| Check | Effect |');
out.push('| --- | --- |');
for (const [name, meaning] of Object.entries(MEANING)) out.push(`| \`${name}\` | ${meaning} |`);
out.push('');
out.push('## Routes with no authentication at all');
out.push('');
if (unauthenticated.length === 0) {
  out.push('None.');
} else {
  out.push('| Method | Path | Why | Source |');
  out.push('| --- | --- | --- | --- |');
  for (const r of unauthenticated) {
    const why =
      EXPECTED_PUBLIC.get(`${r.method} ${r.path}`) ?? '**UNEXPLAINED — treat as a defect.**';
    out.push(`| ${r.method} | \`${r.path}\` | ${why} | \`${r.source}\` |`);
  }
}
out.push('');
out.push('## Every route');
out.push('');
out.push('| Method | Path | Authenticated by | Source |');
out.push('| --- | --- | --- | --- |');
for (const r of rows) {
  const checks = [...r.guards, ...r.inHandler];
  const shown = checks.length === 0 ? '**nothing**' : checks.map((g) => `\`${g}\``).join(', ');
  out.push(`| ${r.method} | \`${r.path}\` | ${shown} | \`${r.source}\` |`);
}
out.push('');

const body = out.join('\n');
const target = 'docs/API_Inventory.md';
if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = read(target);
  } catch {
    console.error(`${target} is missing; run node scripts/dump-api-inventory.mjs`);
    process.exit(1);
  }
  if (current !== body) {
    console.error(`${target} is stale; run node scripts/dump-api-inventory.mjs`);
    process.exit(1);
  }
  console.log(`${target} is current (${rows.length} routes)`);
} else {
  writeFileSync(join(repo, target), body);
  console.log(
    `${target}: ${rows.length} routes, ${unauthenticated.length} with no authentication` +
      (unexplained.length === 0 ? '' : `, ${unexplained.length} UNEXPLAINED`),
  );
  if (unexplained.length > 0) {
    for (const r of unexplained)
      console.error(`  unexplained: ${r.method} ${r.path} (${r.source})`);
    process.exit(1);
  }
}

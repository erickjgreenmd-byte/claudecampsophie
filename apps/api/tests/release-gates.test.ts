import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * AC_SECURITY_04 "static/dynamic secret scans pass": scripts/scan-secrets.mjs --artifacts scans the
 * built release artifacts (Worker bundle, web dist, Expo web export) with the tracked-file
 * detectors. Every credential-shaped value below is assembled at runtime from harmless pieces, so
 * this file never contains one and the static scan of tracked files stays clean. The values are
 * obviously fake and belong to no account.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNER = path.join(ROOT, 'scripts/scan-secrets.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function artifactDir(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pl-artifacts-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function scan(...targets: string[]) {
  const result = spawnSync(process.execPath, [SCANNER, '--artifacts', ...targets], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A structurally valid, unsigned-by-anyone JWT with the given payload (fake signature). */
const jwt = (payload: Record<string, unknown>) =>
  [b64url({ alg: 'HS256', typ: 'JWT' }), b64url(payload), 'Zm'.repeat(20)].join('.');

// Fake credential shapes, assembled so no literal appears in this file.
const FAKE = {
  stripeLive: ['sk', 'live', 'FAKE0FAKE0FAKE0FAKE0FAKE0'].join('_'),
  openAi: ['sk', 'proj', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake0000'].join('-'),
  aws: ['AK', 'IA', 'FAKEFAKEFAKEFAKE'].join(''),
  serviceRole: jwt({ iss: 'supabase', ref: 'fakeproject', role: 'service_role' }),
  userToken: jwt({ sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated' }),
  supabaseSecret: ['sb', 'secret', 'FAKEfakeFAKEfake0000'].join('_'),
  // Documented public values (docs/Connections.md: only these may ship in client bundles).
  anonKey: jwt({ iss: 'supabase', ref: 'fakeproject', role: 'anon' }),
  publishable: ['sb', 'publishable', 'FAKEfakeFAKEfake0000'].join('_'),
  revenueCatIos: ['appl', 'FAKEfakeFAKEfakeFAKEfake00'].join('_'),
  revenueCatAndroid: ['goog', 'FAKEfakeFAKEfakeFAKEfake00'].join('_'),
};

/** One very long minified line, the way bundlers emit them. */
const minified = (inject: string) =>
  `(()=>{${'var a=1;'.repeat(20_000)}const k="${inject}";${'var b=2;'.repeat(20_000)}})();`;

describe('artifact secret scan (AC_SECURITY_04)', () => {
  it('a clean artifact directory passes', () => {
    const dir = artifactDir({
      'index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>',
      'assets/index.js': minified('hello'),
      'assets/index.css': 'body{margin:0}',
      'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      'README.md': 'Built by wrangler',
    });
    const result = scan(dir);
    expect(result).toMatchObject({ status: 0 });
    expect(result.output).toMatch(/Artifact secret scan passed \(5 files/);
  });

  it('finds a planted secret in a minified bundle and reports its line and column, not its value', () => {
    const dir = artifactDir({ 'assets/index.js': minified(FAKE.stripeLive) });
    const result = scan(dir);
    expect(result.status).toBe(1);
    const column = minified(FAKE.stripeLive).indexOf(FAKE.stripeLive) + 1;
    expect(result.output).toContain(`assets/index.js:1:${column}: Stripe live secret`);
    expect(result.output).not.toContain(FAKE.stripeLive);
  });

  it('uses every tracked-file detector and reports each finding', () => {
    const dir = artifactDir({
      'worker/index.js': [
        `const a = "${FAKE.openAi}";`,
        `const b = "${FAKE.aws}";`,
        `const c = "${FAKE.serviceRole}";`,
        `const d = "${FAKE.supabaseSecret}";`,
      ].join('\n'),
    });
    const result = scan(dir);
    expect(result.status).toBe(1);
    for (const finding of [
      'worker/index.js:1:12: OpenAI key',
      'worker/index.js:2:12: AWS access key',
      'worker/index.js:3:12: service-role JWT',
      'worker/index.js:4:12: Supabase secret key',
    ]) {
      expect(result.output).toContain(finding);
    }
    for (const value of Object.values(FAKE)) expect(result.output).not.toContain(value);
  });

  it('scans the original sources inside a source map, but not its encoded mappings', () => {
    const map = {
      version: 3,
      file: 'index.js',
      sources: ['../src/config.ts', '../src/clean.ts'],
      sourcesContent: [
        `export const config = {\n  key: "${FAKE.stripeLive}",\n};\n`,
        'export const ok = 1;\n',
      ],
      names: [],
      // VLQ text can look like a key; it is position data, never a secret.
      mappings: `;;${FAKE.aws};AAAA`,
    };
    const dir = artifactDir({ 'index.js': 'export{};', 'index.js.map': JSON.stringify(map) });
    const result = scan(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'index.js.map (source ../src/config.ts):2:9: Stripe live secret',
    );
    expect(result.output).not.toContain('AWS access key');
  });

  it('allows only the documented public client values; any other embedded token fails', () => {
    const publicOnly = artifactDir({
      'entry.js': minified(
        [FAKE.anonKey, FAKE.publishable, FAKE.revenueCatIos, FAKE.revenueCatAndroid].join('|'),
      ),
    });
    expect(scan(publicOnly)).toMatchObject({ status: 0 });

    const withToken = artifactDir({ 'entry.js': `const t="${FAKE.userToken}";` });
    const result = scan(withToken);
    expect(result.status).toBe(1);
    expect(result.output).toContain('entry.js:1:10: signed JWT');
  });

  it('scans unknown binary files as bytes and every directory it is given', () => {
    const clean = artifactDir({ 'index.html': '<!doctype html>' });
    const binary = artifactDir({
      'module.wasm': Buffer.concat([
        Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
        Buffer.from(FAKE.stripeLive, 'latin1'),
        Buffer.from([0, 0]),
      ]),
    });
    const result = scan(clean, binary);
    expect(result.status).toBe(1);
    expect(result.output).toContain('module.wasm');
    expect(result.output).toContain('Stripe live secret');
  });

  it('a missing or empty artifact directory is a failure, never a pass', () => {
    const empty = artifactDir({});
    expect(scan(empty).status).not.toBe(0);
    expect(scan(empty).output).toMatch(/no files/);
    const missing = path.join(empty, 'not-built');
    expect(scan(missing).status).not.toBe(0);
    expect(scan(missing).output).toMatch(/not a directory/);
    expect(scan().status).not.toBe(0);
  });
});

/**
 * How values really sit in shipped files: inside escaped string literals (minified JSON in JS),
 * URL-encoded, glued to a word, as a JWT whose JSON is not compact, compressed next to the bundle
 * (.gz/.br precompression), behind a symlinked directory, or UTF-16 encoded. Each of these passed
 * the scan before (checker probe, 2026-09-24).
 */
describe('artifact secret scan: encodings, compression and links (AC_SECURITY_04)', () => {
  /** A JWT whose header and payload JSON keep the given (non-compact) formatting. */
  const looseJwt = (payloadJson: string) =>
    [
      Buffer.from('{ "alg": "HS256", "typ": "JWT" }').toString('base64url'),
      Buffer.from(payloadJson).toString('base64url'),
      'Zm'.repeat(20),
    ].join('.');
  const LOOSE = {
    spaced: looseJwt('{ "role": "service_role", "iss": "supabase" }'),
    newline: looseJwt('{\n  "iss": "supabase",\n  "role": "service_role"\n}'),
    tab: looseJwt('{\t"role":"service_role"}'),
    anon: looseJwt('{ "iss": "supabase", "role": "anon" }'),
    user: looseJwt('{ "sub": "00000000-0000-4000-8000-000000000002", "role": "authenticated" }'),
  };

  const ESCAPED: Record<string, [string, string]> = {
    'escaped-newline.js': [`const s="line\\n${FAKE.serviceRole}";`, 'service-role JWT'],
    'escaped-newline-stripe.js': [`const s="line\\n${FAKE.stripeLive}";`, 'Stripe live secret'],
    'unicode-escape.js': [`const s="\\u0022${FAKE.stripeLive}";`, 'Stripe live secret'],
    'hex-escape.js': [`const s="\\x22${FAKE.supabaseSecret}";`, 'Supabase secret key'],
    'glued-word.js': [`const h="Bearer_${FAKE.serviceRole}";`, 'service-role JWT'],
    'url-encoded.js': [`fetch("/v1?k=%20${FAKE.stripeLive}");`, 'Stripe live secret'],
    'tab-escape.js': [`const s="a\\t${FAKE.openAi}";`, 'OpenAI key'],
  };

  it('finds values after escape sequences, percent-encoding and joining characters', () => {
    const dir = artifactDir(
      Object.fromEntries(Object.entries(ESCAPED).map(([name, [content]]) => [name, content])),
    );
    const result = scan(dir);
    expect(result.status).toBe(1);
    for (const [name, [, detector]] of Object.entries(ESCAPED)) {
      expect(result.output).toMatch(new RegExp(`${name}:1:\\d+: ${detector}`));
    }
    for (const value of Object.values(FAKE)) expect(result.output).not.toContain(value);
  });

  it('still ignores the same prefixes inside longer words', () => {
    const dir = artifactDir({
      'words.js': [
        'const a="the-risk-assessment-and-mitigation-plan-overview-text";',
        'const b="desk_live_ABCDEFGHIJKLMNOPQRSTUVWX";',
        'const c="task_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";',
      ].join('\n'),
    });
    expect(scan(dir)).toMatchObject({ status: 0 });
  });

  it('decodes JWTs whose JSON is not compact', () => {
    const dir = artifactDir({
      'a.js': `const k="${LOOSE.spaced}";`,
      'b.js': `const k="${LOOSE.newline}";`,
      'c.js': `const k="${LOOSE.tab}";`,
      'd.js': `const t="${LOOSE.user}";`,
    });
    const result = scan(dir);
    expect(result.status).toBe(1);
    for (const finding of [
      'a.js:1:10: service-role JWT',
      'b.js:1:10: service-role JWT',
      'c.js:1:10: service-role JWT',
      'd.js:1:10: signed JWT',
    ]) {
      expect(result.output).toContain(finding);
    }
    // The documented public anon key stays allowed however its JSON is formatted.
    expect(scan(artifactDir({ 'e.js': `const k="${LOOSE.anon}";` }))).toMatchObject({
      status: 0,
    });
  });

  it('scans gzip, brotli and zstd files as their decompressed content', () => {
    const bundle = minified(FAKE.stripeLive);
    const column = bundle.indexOf(FAKE.stripeLive) + 1;
    const dir = artifactDir({
      'assets/index.js.gz': gzipSync(bundle),
      'assets/index.js.br': brotliCompressSync(bundle),
      'assets/index.js.zst': zstdCompressSync(bundle),
      'assets/clean.js.gz': gzipSync(minified('hello')),
    });
    const result = scan(dir);
    expect(result.status).toBe(1);
    for (const file of ['index.js.gz', 'index.js.br', 'index.js.zst']) {
      expect(result.output).toContain(
        `assets/${file} (decompressed):1:${column}: Stripe live secret`,
      );
    }
    expect(result.output).not.toContain('clean.js.gz');
  });

  it('an archive or compressed file it cannot read fails the scan instead of passing unseen', () => {
    const zipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
    const result = scan(artifactDir({ 'index.html': '<!doctype html>', 'bundle.zip': zipLike }));
    expect(result.status).toBe(2);
    expect(result.output).toMatch(/bundle\.zip: cannot be scanned/);
    const corrupt = scan(artifactDir({ 'index.js.gz': Buffer.from([0x1f, 0x8b, 8, 0, 1, 2]) }));
    expect(corrupt.status).toBe(2);
    expect(corrupt.output).toMatch(/index\.js\.gz: cannot be scanned/);
  });

  it('follows symlinked directories (without looping) instead of skipping them', () => {
    const outside = artifactDir({ 'config.js': `const k="${FAKE.stripeLive}";` });
    const dir = artifactDir({ 'index.html': '<!doctype html>' });
    symlinkSync(outside, path.join(dir, 'linked'), 'dir');
    symlinkSync(dir, path.join(dir, 'loop'), 'dir');
    const result = scan(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('linked/config.js:1:10: Stripe live secret');
  });

  it('finds values in UTF-16 text (little and big endian)', () => {
    const text = `key=${FAKE.stripeLive}\n`;
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const be = Buffer.from(le);
    be.swap16();
    const result = scan(artifactDir({ 'strings-le.txt': le, 'strings-be.txt': be }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('strings-le.txt (UTF-16):1:5: Stripe live secret');
    expect(result.output).toContain('strings-be.txt (UTF-16):1:5: Stripe live secret');
  });
});

/**
 * The tracked-file scan (CI's first step and the pre-commit gate) shares the detectors. Its
 * service-role rule only matched one base64 alignment of "service_role", so a real-shaped Supabase
 * key ({"iss":"supabase","ref":…,"role":"service_role"}) passed; JWTs are now decoded instead.
 */
describe('tracked-file secret scan', () => {
  function repoWith(files: Record<string, string>): string {
    const dir = artifactDir(files);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('add', '.');
    return dir;
  }

  const trackedScan = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };

  it('finds a Supabase service-role key whatever the base64 alignment of its role claim', () => {
    for (const payload of [
      { iss: 'supabase', ref: 'fakeprojectref00000a', role: 'service_role', iat: 1, exp: 2 },
      { iss: 'supabase-demo', role: 'service_role', exp: 1 },
      { role: 'service_role' },
    ]) {
      const repo = repoWith({ 'config.ts': `export const key = "${jwt(payload)}";\n` });
      for (const args of [[], ['--staged']]) {
        const result = trackedScan(repo, ...args);
        expect({ payload, args, status: result.status }).toEqual({ payload, args, status: 1 });
        expect(result.output).toContain('config.ts:1: service-role JWT');
      }
    }
  });

  it('finds values after an escape sequence and in non-compact JWTs', () => {
    const loose = [
      Buffer.from('{ "alg": "HS256" }').toString('base64url'),
      Buffer.from('{ "role": "service_role" }').toString('base64url'),
      'Zm'.repeat(20),
    ].join('.');
    const repo = repoWith({
      'fixture.json': `{"note":"line\\n${FAKE.stripeLive}"}\n`,
      'config.ts': `export const key = "${loose}";\n`,
    });
    for (const args of [[], ['--staged']]) {
      const result = trackedScan(repo, ...args);
      expect(result.status).toBe(1);
      expect(result.output).toContain('fixture.json:1: Stripe live secret');
      expect(result.output).toContain('config.ts:1: service-role JWT');
    }
  });

  it('still passes a clean repository and never flags the public anon key', () => {
    const repo = repoWith({
      'config.ts': `export const anon = "${FAKE.anonKey}";\nexport const n = 1;\n`,
    });
    expect(trackedScan(repo)).toMatchObject({ status: 0 });
    expect(trackedScan(repo, '--staged')).toMatchObject({ status: 0 });
  });
});

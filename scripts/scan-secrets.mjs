#!/usr/bin/env node
// Secret scan (spec E4 / T15, AC_SECURITY_03, AC_SECURITY_04). Fails on credential-shaped values.
// Deliberately simple and dependency-free; not a replacement for the provider's push protection.
//
//   node scripts/scan-secrets.mjs                       # tracked files on disk (CI)
//   node scripts/scan-secrets.mjs --staged              # the git index (pre-commit)
//   node scripts/scan-secrets.mjs --artifacts <dir>...  # built release artifacts (CI, after builds)
//
// Findings name the file, position and detector, never the matched value (CI logs are shared).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';

// Detectors marked `anchored` must start a value: after a non-alphanumeric character, or right
// after an escape that a string literal or URL puts in front of it. Minified bundles keep JSON and
// text inside escaped literals ("line\nsk_live_…", ""…", "%20…"), where a plain word
// boundary never matches, while "desk_live_…" or "risk-…" inside a longer word stays ignored.
const ESCAPE_BEFORE = /(?:\\[nrtbfv0]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|%[0-9A-Fa-f]{2})$/;
function startsValue(text, index) {
  if (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1])) return true;
  return ESCAPE_BEFORE.test(text.slice(Math.max(0, index - 6), index));
}

/** Matches of `re` (global) in `text`; anchored matches must start a value (see startsValue). */
function* matches(text, re, anchored) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (!anchored || startsValue(text, m.index)) yield m;
    // A rejected match (inside a longer word) must not hide a real value that starts within it.
    else re.lastIndex = m.index + 1;
  }
}

/** [name, global regex, anchored] */
const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g, false],
  ['Stripe live secret', /sk_live_[0-9A-Za-z]{16,}/g, true],
  // Test-mode keys are secrets too: this project's Stripe account runs in test mode
  // (docs/Connections.md), so they are the keys it actually holds (LRD-3).
  ['Stripe test secret', /sk_test_[0-9A-Za-z]{16,}/g, true],
  ['Stripe restricted key', /rk_(?:live|test)_[0-9A-Za-z]{16,}/g, true],
  ['Stripe webhook secret', /whsec_[0-9A-Za-z]{24,}/g, true],
  ['OpenAI key', /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, true],
  ['AWS access key', /AKIA[0-9A-Z]{16}\b/g, true],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}/g, true],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g, true],
  ['RevenueCat secret key', /sk_[A-Za-z0-9]{28,}\b/g, true],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{16,}/g, true],
  // A Supabase service-role JWT whose payload happens to encode "service_role" at this alignment.
  // Kept as a fallback; decodeJwtRole below catches every alignment (the base64 of the role claim
  // depends on its byte offset, so this pattern alone missed real-shaped keys).
  [
    'service-role JWT',
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}/g,
    false,
  ],
];

// A JWT-shaped value (header.payload.signature). Base64 of "{" followed by a quote or space starts
// "ey"; followed by a newline or tab it starts "ew", so a JWT whose JSON is not compact is matched
// too. Tracked sources may hold test tokens, so only the service-role check applies there; a built
// artifact ships every token it holds to the public.
const JWT = /e[wy][A-Za-z0-9_-]{11,}\.e[wy][A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}/g;

/** A base64url segment decoded as a JSON object, or null. */
function jsonSegment(segment) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether a JWT-shaped match is a token: the compact form ("eyJ…" header and payload, as before),
 * or header and payload that both decode to JSON objects (whitespace-formatted JSON).
 */
function isJwt(token) {
  const [header, payload] = token.split('.');
  if (header.startsWith('eyJ') && payload.startsWith('eyJ')) return true;
  return jsonSegment(header) !== null && jsonSegment(payload) !== null;
}

/** The `role` claim of a JWT-shaped value, or null when the payload is not readable JSON. */
function decodeJwtRole(token) {
  const role = jsonSegment(token.split('.')[1] ?? '')?.role;
  return typeof role === 'string' ? role : null;
}

/**
 * Values documented as public (docs/Connections.md, "Rules enforced in code"): only the Supabase
 * URL and publishable key, the API base URL and the RevenueCat public SDK keys may ship in client
 * bundles. The legacy Supabase publishable key is a JWT whose role is `anon`; it is the only one a
 * detector matches today. The others are listed so a new detector cannot silently start failing on
 * them, and so the list of what may enter a client is in one place. Nothing else is ever allowed.
 */
const DOCUMENTED_PUBLIC = [
  ['Supabase anon (legacy publishable) key', (value) => decodeJwtRole(value) === 'anon'],
  ['Supabase publishable key', (value) => /^sb_publishable_[A-Za-z0-9_-]+$/.test(value)],
  ['RevenueCat public SDK key', (value) => /^(?:appl|goog)_[A-Za-z0-9]+$/.test(value)],
];
const isDocumentedPublic = (value) => DOCUMENTED_PUBLIC.some(([, matches]) => matches(value));

/**
 * A connection string with an inline password (DATABASE_URL is a documented server secret; LRD-3).
 * Groups: 1 password, 2 host. The user may be empty ("redis://:password@host"). A password or host
 * cannot contain a quote, backslash (an escape in a string literal) or whitespace.
 */
const DATABASE_URL =
  /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/?#@'"`\\]*:([^\s/?#@'"`\\]+)@(\[[^\]\s'"`\\]*\]|[^\s:/?#'"`\\]+)/gi;

/**
 * Hosts that never hold a real deployment's data: this machine (local development and CI) and the
 * names reserved for documentation and testing (RFC 2606, RFC 6761).
 */
const LOCAL_OR_RESERVED_HOST =
  /^(?:localhost|[a-z0-9.-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|host\.docker\.internal|(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|test|invalid))\.?$/i;

/** A documentation placeholder standing in for the password, never a password itself. */
const PLACEHOLDER_PASSWORD =
  /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\[[^\]]*\]|\{\{?[^}]*\}\}?|%[A-Za-z_]+%|\*+|x+|\.{3}|password|passwd|pass|pwd|secret|changeme|your[-_]?password)$/i;

/**
 * A `data:` URI whose payload is base64 (any media type and parameters). Bundlers inline small
 * assets, fonts and workers this way, so a value in the payload is invisible to the text rules.
 */
const DATA_URI =
  /data:(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?(?:;[a-z0-9!#$&^_.+-]+=[^;,\s'"`]*)*;base64,([A-Za-z0-9+/_-]{16,}={0,2})/gi;
const DATA_URI_SUFFIX = ' in base64 data URI';
const MAX_DATA_URI_DEPTH = 2;

/**
 * Texts to scan in a decoded data URI payload. An inline source map is read like a .map file: its
 * embedded sources and its other fields, never `mappings` (base64 VLQ position data).
 */
function dataUriTexts(bytes) {
  const text = bytes.subarray(0, 8192).includes(0)
    ? bytes.toString('latin1')
    : bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return [text];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [text];
  const maps = Array.isArray(value.sections) ? value.sections.map((s) => s?.map ?? {}) : [value];
  if (!maps.some((m) => typeof m?.mappings === 'string')) return [text];
  const texts = [];
  for (const m of maps) {
    const { mappings: _mappings, sourcesContent, ...rest } = m ?? {};
    texts.push(JSON.stringify(rest));
    for (const source of Array.isArray(sourcesContent) ? sourcesContent : []) {
      if (typeof source === 'string') texts.push(source);
    }
  }
  if (Array.isArray(value.sections)) {
    const { sections: _sections, ...top } = value;
    texts.push(JSON.stringify(top));
  }
  return texts;
}

/**
 * Every detector hit in `text` as { index, name }. `artifact` adds the built-artifact rules: any
 * signed JWT except a documented public one. Base64 data URIs are decoded and scanned too (to
 * `MAX_DATA_URI_DEPTH` levels); their hits are reported at the URI.
 */
function findSecrets(text, { artifact, depth = 0 }) {
  const hits = [];
  for (const [name, re, anchored] of PATTERNS) {
    for (const m of matches(text, re, anchored)) {
      if (artifact && isDocumentedPublic(m[0])) continue;
      hits.push({ index: m.index, name });
    }
  }
  for (const m of matches(text, JWT, true)) {
    if (!isJwt(m[0])) continue;
    const role = decodeJwtRole(m[0]);
    if (role === 'service_role') hits.push({ index: m.index, name: 'service-role JWT' });
    else if (artifact && !isDocumentedPublic(m[0]))
      hits.push({ index: m.index, name: 'signed JWT' });
  }
  for (const m of matches(text, DATABASE_URL, true)) {
    const [, password, host] = m;
    if (LOCAL_OR_RESERVED_HOST.test(host) || PLACEHOLDER_PASSWORD.test(password)) continue;
    hits.push({ index: m.index, name: 'database URL with password' });
  }
  if (depth < MAX_DATA_URI_DEPTH) {
    // Collected first: the scan of a payload reuses DATA_URI, whose lastIndex this loop depends on.
    const uris = [...matches(text, DATA_URI, true)].map((m) => ({ index: m.index, payload: m[1] }));
    for (const { index, payload } of uris) {
      for (const inner of dataUriTexts(Buffer.from(payload, 'base64'))) {
        for (const hit of findSecrets(inner, { artifact, depth: depth + 1 })) {
          const name = hit.name.endsWith(DATA_URI_SUFFIX) ? hit.name : hit.name + DATA_URI_SUFFIX;
          hits.push({ index, name });
        }
      }
    }
  }
  const seen = new Set();
  return hits
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
    .filter((h) => {
      const key = `${h.index}:${h.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 1-based line and column of `index` in `text`. */
function position(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return { line, column: index - lineStart + 1 };
}

// ---------------------------------------------------------------------------------------------
// Tracked files / git index
// ---------------------------------------------------------------------------------------------

const skip = (f) =>
  !f || /\.(png|jpe?g|gif|ico|pdf|woff2?|zip)$/i.test(f) || f === 'pnpm-lock.yaml';

/** @returns {[string, string][]} [path, text] pairs */
function readIndex() {
  const entries = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { path, blob: meta.split(' ')[1] };
    })
    .filter((e) => !skip(e.path));
  if (entries.length === 0) return [];
  const out = execFileSync('git', ['cat-file', '--batch'], {
    input: entries.map((e) => e.blob).join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  const result = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = out.indexOf(10, offset);
    const size = Number(out.subarray(offset, headerEnd).toString('utf8').split(' ')[2]);
    const start = headerEnd + 1;
    result.push([entry.path, out.subarray(start, start + size).toString('utf8')]);
    offset = start + size + 1;
  }
  return result;
}

function readTracked() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => !skip(f))
    .flatMap((file) => {
      try {
        return [[file, readFileSync(file, 'utf8')]];
      } catch {
        return [];
      }
    });
}

function scanTracked(staged) {
  // --staged scans the git index (what the commit will contain), so a pre-commit check is not
  // decided by unstaged working-tree edits (BUG-034 class). Default: tracked files on disk (CI).
  const files = staged ? readIndex() : readTracked();
  const findings = new Set();
  for (const [file, text] of files) {
    for (const hit of findSecrets(text, { artifact: false })) {
      findings.add(`${file}:${position(text, hit.index).line}: ${hit.name}`);
    }
  }
  if (findings.size > 0) {
    console.error(`Secret scan failed (${findings.size}):\n${[...findings].join('\n')}`);
    process.exit(1);
  }
  console.log(`Secret scan passed (${files.length} ${staged ? 'staged' : 'tracked'} files).`);
}

// ---------------------------------------------------------------------------------------------
// Built artifacts (Worker bundle, web dist, Expo web export)
// ---------------------------------------------------------------------------------------------

/**
 * Every file under `dir`. Symlinks are followed, directories included (a deploy tool may upload
 * what they point at); each real directory is visited once, so a link loop ends.
 */
function walk(dir, visited = new Set()) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(real)) return [];
  visited.add(real);
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    let stat = entry;
    if (entry.isSymbolicLink()) {
      try {
        stat = statSync(full);
      } catch {
        continue; // A dangling link ships nothing.
      }
    }
    if (stat.isDirectory()) out.push(...walk(full, visited));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

/**
 * Text as a bundler wrote it: UTF-8, unless the bytes hold NULs (images, fonts, wasm), which are
 * read byte for byte so embedded strings are still seen and positions stay stable.
 */
function decode(bytes) {
  return bytes.subarray(0, 8192).includes(0) ? bytes.toString('latin1') : bytes.toString('utf8');
}

/**
 * UTF-16 readings of bytes that hold NULs: by byte-order mark when there is one, otherwise both
 * alignments (UTF-16 strings embedded in a binary). ASCII in UTF-16 is invisible to the byte view.
 */
function utf16Texts(bytes) {
  if (!bytes.includes(0)) return [];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return [bytes.subarray(2).toString('utf16le')];
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return [swapped.swap16().toString('utf16le')];
  }
  return [bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')];
}

const startsWith = (bytes, magic) => magic.every((b, i) => bytes[i] === b);
const MAX_DECOMPRESSED = 256 * 1024 * 1024;

/**
 * Compressed files (precompressed .gz/.br/.zst assets, tarballs) are scanned as their content.
 * Archives whose members are compressed individually (zip and the formats Node cannot read) are
 * reported as unscannable, never passed unseen: unpack them and pass the directory instead.
 */
function unpack(name, bytes) {
  const limit = { maxOutputLength: MAX_DECOMPRESSED };
  if (startsWith(bytes, [0x1f, 0x8b])) return { bytes: gunzipSync(bytes, limit) };
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd]))
    return { bytes: zstdDecompressSync(bytes, limit) };
  if (/\.br$/i.test(name)) return { bytes: brotliDecompressSync(bytes, limit) };
  for (const [format, magic] of [
    ['zip', [0x50, 0x4b, 0x03, 0x04]],
    ['zip', [0x50, 0x4b, 0x05, 0x06]],
    ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
    ['bzip2', [0x42, 0x5a, 0x68, null, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ]) {
    if (magic.every((b, i) => b === null || bytes[i] === b))
      return { unreadable: `${format} archive` };
  }
  return null;
}

/**
 * A source map is scanned as the original sources it embeds (findings point at the source file and
 * line) plus its other fields. `mappings` is skipped: it is base64 VLQ position data, never a
 * value, and long runs of it can look like a key.
 */
function scanSourceMap(label, text, report) {
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof map !== 'object' || map === null) return false;
  const maps = Array.isArray(map.sections) ? map.sections.map((s) => s?.map ?? {}) : [map];
  for (const m of maps) {
    const { mappings: _mappings, sourcesContent, ...rest } = m;
    const restText = JSON.stringify(rest);
    for (const hit of findSecrets(restText, { artifact: true })) report(label, restText, hit);
    (Array.isArray(sourcesContent) ? sourcesContent : []).forEach((source, i) => {
      if (typeof source !== 'string') return;
      const name = Array.isArray(m.sources) ? m.sources[i] : undefined;
      const sourceLabel = `${label} (source ${name ?? `#${i}`})`;
      for (const hit of findSecrets(source, { artifact: true })) report(sourceLabel, source, hit);
    });
  }
  return true;
}

/** Scans one file's bytes: decompressed content, source maps, text, and UTF-16 readings. */
function scanBytes(name, label, bytes, { report, unscannable }, depth = 0) {
  let unpacked;
  try {
    unpacked = unpack(name, bytes);
  } catch (error) {
    unscannable(label, `cannot be decompressed (${error?.code ?? 'error'})`);
    return;
  }
  if (unpacked?.unreadable) {
    unscannable(label, unpacked.unreadable);
    return;
  }
  if (unpacked) {
    if (depth >= 3) {
      unscannable(label, 'nested compression');
      return;
    }
    const inner = name.replace(/\.(?:gz|tgz|br|zst)$/i, (ext) => (ext === '.tgz' ? '.tar' : ''));
    scanBytes(inner, `${label} (decompressed)`, unpacked.bytes, { report, unscannable }, depth + 1);
    return;
  }
  const text = decode(bytes);
  if (name.endsWith('.map') && scanSourceMap(label, text, report)) return;
  for (const hit of findSecrets(text, { artifact: true })) report(label, text, hit);
  for (const wide of utf16Texts(bytes)) {
    for (const hit of findSecrets(wide, { artifact: true })) report(`${label} (UTF-16)`, wide, hit);
  }
}

function scanArtifacts(dirs) {
  if (dirs.length === 0) {
    console.error('Usage: scan-secrets.mjs --artifacts <dir> [<dir> ...]');
    process.exit(2);
  }
  const findings = new Set();
  const unreadable = new Set();
  const sink = {
    report: (label, text, hit) => {
      const { line, column } = position(text, hit.index);
      findings.add(`${label}:${line}:${column}: ${hit.name}`);
    },
    unscannable: (label, reason) =>
      unreadable.add(
        `${label}: cannot be scanned (${reason}); unpack it and pass the directory to --artifacts`,
      ),
  };
  let files = 0;
  let bytes = 0;
  for (const dir of dirs) {
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      stat = null;
    }
    // A missing build is a failure, never a pass: nothing was checked.
    if (!stat?.isDirectory()) {
      console.error(`Artifact secret scan failed: ${dir} is not a directory (was it built?)`);
      process.exit(2);
    }
    const list = walk(dir);
    if (list.length === 0) {
      console.error(`Artifact secret scan failed: ${dir} has no files (was it built?)`);
      process.exit(2);
    }
    for (const file of list) {
      const content = readFileSync(file);
      files += 1;
      bytes += content.length;
      const label = path.join(path.basename(path.resolve(dir)), path.relative(dir, file));
      scanBytes(file, label, content, sink);
    }
  }
  if (findings.size > 0 || unreadable.size > 0) {
    const all = [...findings, ...unreadable];
    const shown = all.slice(0, 200);
    const more = all.length - shown.length;
    console.error(
      `Artifact secret scan failed (${findings.size} findings, ${unreadable.size} unscannable):\n${shown.join('\n')}${more > 0 ? `\n… and ${more} more` : ''}`,
    );
    // 1: a secret-shaped value was found; 2: something could not be checked.
    process.exit(findings.size > 0 ? 1 : 2);
  }
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `Artifact secret scan passed (${files} files, ${mib} MiB in ${dirs.length} ${dirs.length === 1 ? 'directory' : 'directories'}).`,
  );
}

const args = process.argv.slice(2);
if (args.includes('--artifacts')) {
  scanArtifacts(args.filter((a) => a !== '--artifacts'));
} else {
  scanTracked(args.includes('--staged'));
}

#!/usr/bin/env node
// Secret scan over tracked files (spec E4 / T15, AC_SECURITY_03). Fails on credential-shaped values.
// Deliberately simple and dependency-free; not a replacement for the provider's push protection.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['Stripe live secret', /\bsk_live_[0-9A-Za-z]{16,}/],
  ['Stripe restricted key', /\brk_live_[0-9A-Za-z]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[0-9A-Za-z]{24,}/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['RevenueCat secret key', /\bsk_[A-Za-z0-9]{28,}\b/],
  // A Supabase service-role JWT (any signed JWT with role service_role in its payload).
  [
    'service-role JWT',
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}/,
  ],
];

// --staged scans the git index (what the commit will contain), so a pre-commit check is not
// decided by unstaged working-tree edits (BUG-034 class). Default: tracked files on disk (CI).
const staged = process.argv.includes('--staged');
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

const files = staged ? readIndex() : readTracked();
const findings = [];
for (const [file, text] of files) {
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
    }
  });
}

if (findings.length > 0) {
  console.error(`Secret scan failed (${findings.length}):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} ${staged ? 'staged' : 'tracked'} files).`);

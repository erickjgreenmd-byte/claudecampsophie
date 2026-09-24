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
  ['service-role JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}/],
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && !/\.(png|jpe?g|gif|ico|pdf|woff2?|zip)$/i.test(f) && f !== 'pnpm-lock.yaml');

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
    }
  });
}

if (findings.length > 0) {
  console.error(`Secret scan failed (${findings.length}):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);

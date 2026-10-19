#!/usr/bin/env node
/**
 * Derive docs/Open_Work.md — every defect that is not closed, every residual a closed defect left
 * behind, and the debt a reader pricing this work needs to know about.
 *
 *   node scripts/dump-open-work.mjs            # write docs/Open_Work.md
 *   node scripts/dump-open-work.mjs --check    # fail if the file on disk is stale
 *
 * WHY DERIVED. docs/Bug_Ledger.md is the authoritative record and it is over 700 KB in one table.
 * Nobody outside this project will read it, so "the open defects" has to be answerable without
 * reading it — and a hand-written summary of a growing ledger is the drift this repository has
 * already recorded four times (BUG-411, BUG-426, BUG-430, BUG-432). The ledger stays the source;
 * this file is generated from it and checked in the gate.
 *
 * The judged sections — the debt list, what has never run — are written here in the script rather
 * than in the document, so there is exactly one place to change them and no second copy to drift.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(repo, p), 'utf8');

const ledger = read('docs/Bug_Ledger.md');
const cell = (s) => s.replace(/^\s+|\s+$/g, '');

/** One row per `| BUG-nnn |` line. Cells can contain pipes inside code spans, so the tail is read
 *  from the end: the last two cells are always "Regression evidence" and "Next". */
const rows = [];
for (const line of ledger.split('\n')) {
  if (!/^\| BUG-/.test(line)) continue;
  const parts = line.split('|');
  rows.push({
    id: cell(parts[1]),
    severity: cell(parts[2]),
    state: cell(parts[3]),
    detail: cell(parts[5] ?? ''),
    next: cell(parts[parts.length - 2] ?? ''),
  });
}
if (rows.length < 100)
  throw new Error(`only ${rows.length} ledger rows parsed — the table shape changed`);

const isClosed = (state) => /^closed\b/i.test(state) || /^\*\*CLOSED/i.test(state);
const open = rows.filter((r) => !isClosed(r.state));
// A row whose State says it left a residual, but whose Next then records that residual as closed.
// The State label is the stale one; reporting 41 open remainders when two were later finished is
// the same record drift this file exists to prevent, so they are counted and listed separately.
const marked = rows.filter((r) => isClosed(r.state) && /residual/i.test(r.state));
const resolvedLater = marked.filter((r) => /^\*{0,2}CLOSED\b/i.test(r.next));
const residual = marked.filter((r) => !resolvedLater.includes(r));

const ownerActions = (read('docs/Owner_Actions.md').match(/^\| \d+ \|/gm) ?? []).length;
const lessons = (read('docs/Lessons_Learned.md').match(/^\| L-\d+/gm) ?? []).length;
const migrations = readdirSync(join(repo, 'supabase/migrations')).filter((f) =>
  f.endsWith('.sql'),
).length;
const floors = JSON.parse(read('scripts/test-minimums.json'));
const tests = Object.values(floors).reduce((a, b) => a + b, 0);

const trim = (s, n) => {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

/**
 * Debt a reader pricing this work needs, each one checkable at the path given. Judged, not derived:
 * "what is wrong with this as a place for a team" is not something a regex can decide. Kept here so
 * the document has no hand-edited half.
 */
const DEBT = [
  [
    'Production cannot boot, on purpose',
    '`CONSENT_ADAPTERS` is an empty set (`apps/api/src/config.ts:274`) and `CONSENT_ADAPTER_FACTORIES` is an empty object (`apps/api/src/index.ts:91`), so `providers.consent` can never read `configured` and `APP_ENV=production` fails readiness. That is the right failure — a labeled development mock must never serve a real family — but it means the production path has never been exercised end to end, and it will not be until a consent vendor is contracted (owner action #7).',
  ],
  [
    'No end-to-end test exists',
    'Zero tests drive a running stack. Every one of the 366 test files is a unit or integration test against a fake provider or a real local Postgres; there is no Playwright, no device harness, and no test that starts the Worker and the portal together. Any claim about the system as a whole is an inference from parts that each pass.',
  ],
  [
    'Two mobile rules are pinned by source assertions, not behaviour',
    'The vitest project for `apps/mobile` cannot import `react-native`, so hooks that enforce parent/child separation are asserted against their source text rather than rendered (BUG-289, BUG-336). A refactor that keeps the strings and breaks the behaviour would pass.',
  ],
  [
    'The bug ledger is past the size where it functions as a record',
    '`docs/Bug_Ledger.md` is one markdown table over 700 KB. It is complete and it is append-only on purpose, but it is no longer something a human reads, which is why this file exists. Splitting it by round is the obvious fix and has not been done.',
  ],
  [
    'Response schemas are strict, so adding a field breaks installed apps',
    'Clients parse responses with `strictObject`, so a server that adds a field fails every client that has not shipped yet (BUG-420, accepted open with a named trigger). The first additive API change after a store release is a forced app update unless this is changed first.',
  ],
  [
    'Three tests assert wall-clock budgets and fail under CPU contention',
    "`packages/domain/src/safety/screen.test.ts` has three cases that measure elapsed time and assert it is under 750 ms. On a 4-core container running a second full suite at the same time they measured 915 ms and failed (BUG-440). These are the awkward kind: the 750 ms is an assertion about the code's cost, not a harness timeout, so `scripts/check-test-timeout-margin.mjs` — which guards the whole suite against tests creeping up on their *timeouts* (BUG-442) — does not and cannot cover them. They were not weakened. A contractor who sees exactly these three red should check the machine's load before the code; anything else red is real.",
  ],
  [
    'The records are large, numerous, and the thing that most needs discipline',
    `${rows.length} ledger rows, ${lessons} lessons, ${ownerActions} owner actions and sixteen other documents in \`docs/\`. Four defects (BUG-411, BUG-426, BUG-430, BUG-432) were records that contradicted the code, not code faults. \`docs/Source_Of_Truth.md\` sets which documents bind and which are history; read it before trusting a sentence in \`docs/\`.`,
  ],
];

/** Things that have never executed once. The gap between "every test passes" and "it works". */
const NEVER_RUN = [
  [
    'Any deployment',
    'No Worker, no portal, no native build has ever been deployed, to any environment.',
  ],
  [
    'Both deploy workflows',
    '`.github/workflows/deploy-api.yml` and `deploy-web.yml` have run zero times. They are code that has never executed; "it parses" is not "it works" (lesson L-085).',
  ],
  [
    'The migration workflow, and the hosted schema',
    '`.github/workflows/db-migrate.yml` has run zero times. The hosted Supabase project holds zero tables in `public`, `private` and `app` — the schema has never been applied anywhere but a local or CI database.',
  ],
  [
    'Every external provider',
    'OpenAI, RevenueCat, Stripe, Resend and the consent vendor have never been called with a real credential. Every provider test runs against a labeled mock or a fake `fetch`.',
  ],
  ['A native build', 'No EAS build has been produced, so no store has ever seen a binary.'],
];

const out = [];
out.push('# PencilLift — open work');
out.push('');
out.push(
  'Generated by `node scripts/dump-open-work.mjs` from `docs/Bug_Ledger.md`,',
  '`docs/Owner_Actions.md` and `docs/Lessons_Learned.md`. **Do not hand-edit** — change the ledger or',
  'the script. The gate fails if this file has drifted from them.',
);
out.push('');
out.push(
  `At ${migrations} migrations and ${tests.toLocaleString('en-US')} passing tests, the ledger holds`,
  `**${rows.length} defect rows**: **${open.length} not closed**, ${residual.length} closed with a`,
  `named residual, and ${rows.length - open.length - marked.length} closed clean. ${ownerActions} owner`,
  'actions are open — see `docs/Owner_Beta_Checklist.md` for the four that are the whole deployment.',
);
out.push('');
out.push('## Defects that are open');
out.push('');
out.push(
  'Each was reproduced, and each was left open deliberately with the reason recorded. None is a',
  'forgotten item.',
);
out.push('');
out.push('| ID | Severity | State | What happens |');
out.push('| --- | --- | --- | --- |');
for (const r of open) {
  out.push(
    `| ${r.id} | ${trim(r.severity, 150)} | ${trim(r.state, 90)} | ${trim(r.detail, 320)} |`,
  );
}
out.push('');
out.push('## Residuals left by closed defects');
out.push('');
out.push(
  'A defect closes when the failure it describes no longer reproduces. Where the fix was narrower',
  'than the problem, the remainder is written into the row\'s "Next" column rather than dropped, and',
  `those ${residual.length} remainders are reproduced here verbatim. This is the honest list of what a`,
  'green suite does not cover.',
);
out.push('');
out.push('| ID | Severity | What is left |');
out.push('| --- | --- | --- |');
for (const r of residual) {
  out.push(`| ${r.id} | ${trim(r.severity, 140)} | ${trim(r.next, 420)} |`);
}
out.push('');
if (resolvedLater.length > 0) {
  out.push(
    `${resolvedLater.length} further row(s) are labelled as leaving a residual, but their "Next" column`,
    'records it as since closed, so they are listed here rather than above and the label is what is',
    `stale: ${resolvedLater.map((r) => r.id).join(', ')}.`,
  );
  out.push('');
}
out.push('## Technical debt');
out.push('');
for (const [title, body] of DEBT) {
  out.push(`**${title}.** ${body}`);
  out.push('');
}
out.push('## What has never run');
out.push('');
out.push(
  'Every suite passes and nothing has ever served a request. These are different kinds of done, and',
  'the second one is where the remaining risk is.',
);
out.push('');
for (const [title, body] of NEVER_RUN) out.push(`- **${title}.** ${body}`);
out.push('');
out.push('## Where to look next');
out.push('');
out.push('| Question | Document |');
out.push('| --- | --- |');
out.push(
  '| The full reproduction, hypotheses and evidence for one defect | `docs/Bug_Ledger.md` |',
);
out.push(
  '| What only the owner can do, in order, with costs | `docs/Owner_Beta_Checklist.md`, `docs/Owner_Actions.md` |',
);
out.push('| Which requirement each test covers | `docs/Requirement_Coverage.md` |');
out.push(
  '| The mistakes this project made, and the controls that followed | `docs/Lessons_Learned.md` |',
);
out.push('| Which documents bind a future contributor | `docs/Source_Of_Truth.md` |');
out.push('');

const body = out.join('\n');
const target = 'docs/Open_Work.md';
if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = read(target);
  } catch {
    console.error(`${target} is missing; run node scripts/dump-open-work.mjs`);
    process.exit(1);
  }
  if (current !== body) {
    console.error(`${target} is stale; run node scripts/dump-open-work.mjs`);
    process.exit(1);
  }
  console.log(`${target} is current (${open.length} open, ${residual.length} residual)`);
} else {
  writeFileSync(join(repo, target), body);
  console.log(`${target}: ${rows.length} rows — ${open.length} open, ${residual.length} residual`);
}

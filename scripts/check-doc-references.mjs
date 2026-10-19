#!/usr/bin/env node
/**
 * Mechanical cross-reference checks over the records (lesson L-084: cross-reference checking is
 * mechanical, not prose review — a careful reading has missed every one of the following).
 *
 *   node scripts/check-doc-references.mjs
 *
 * Six defects in this repository were records that contradicted the code rather than code faults
 * (BUG-411, BUG-426, BUG-430, BUG-432, BUG-433, BUG-436), and each was a claim a human had read
 * past. These checks are the control, so the class cannot return:
 *
 *   1. Every markdown record is classified in a tier of docs/Source_Of_Truth.md. A page that says
 *      which documents to trust is worthless if it does not mention the one in front of you
 *      (BUG-438).
 *   2. Every `docs/Threat_Model.md T<n>` citation resolves to a row that exists. A citation that
 *      points nowhere is worse than none: a reader who follows it concludes the residual was
 *      written down when it was not (BUG-435).
 *   3. Test-count figures quoted in a CURRENT-STATE record (Tier 1 and Tier 2) match
 *      scripts/test-minimums.json. The ledgers are exempt because they are append-only by
 *      definition — a floor inside a 2026-09-30 run record is correct as history, and "correcting"
 *      it would be falsifying the history (BUG-433, BUG-436).
 *   4. `private.child_pins` still has no writer. Spec P3 wants a child PIN to select a child on a
 *      shared paired device; the table exists and nothing writes it (BUG-437, threat T39). Pinned
 *      so that the day the feature is started, this says what else has to be finished with it.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(repo, p), 'utf8');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: repo,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const sources = tracked.filter((f) => /\.(ts|tsx|sql|md|mjs|mts)$/.test(f));

const problems = [];
const say = (p) => problems.push(p);

// ---------------------------------------------------------------------------------------------
// 1. Every record is classified
// ---------------------------------------------------------------------------------------------
const sot = read('docs/Source_Of_Truth.md');
const tiers = [1, 2, 3, 4].map((n) => {
  const from = sot.indexOf(`### Tier ${n} —`);
  const next =
    n === 4 ? sot.indexOf('### Every record is classified') : sot.indexOf(`### Tier ${n + 1} —`);
  if (from === -1 || next === -1 || next < from)
    throw new Error(`Tier ${n} section not found in Source_Of_Truth.md`);
  return sot.slice(from, next);
});
/** Paths named inside a tier's section, from `backtick` spans. */
const classified = new Map();
tiers.forEach((section, i) => {
  for (const m of section.matchAll(/`([A-Za-z0-9_./-]+\.md)`/g)) {
    if (!classified.has(m[1])) classified.set(m[1], i + 1);
  }
});
// `reference/` is named as a directory; every file under it is Tier 4 by that line.
const records = sources.filter((f) => f.endsWith('.md') && !f.startsWith('reference/'));
for (const f of records) {
  // A root file may be named with or without its directory; records under docs/ are named in full.
  if (classified.has(f) || classified.has(f.replace(/^docs\//, ''))) continue;
  say(`${f} is in no tier of docs/Source_Of_Truth.md — classify it there`);
}

// ---------------------------------------------------------------------------------------------
// 2. Threat_Model citations
// ---------------------------------------------------------------------------------------------
const threatRows = new Set(
  [...read('docs/Threat_Model.md').matchAll(/^\| (T\d+) \|/gm)].map((m) => m[1]),
);
if (threatRows.size < 38)
  say(`parsed only ${threatRows.size} threat rows — the table shape changed`);
for (const file of sources) {
  if (file === 'docs/Threat_Model.md') continue;
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/Threat_Model\.md[^.]{0,40}?\b(T\d+)\b/g)) {
        if (!threatRows.has(m[1]))
          say(`${file}:${i + 1} cites docs/Threat_Model.md ${m[1]}, which has no row`);
      }
    });
}

// ---------------------------------------------------------------------------------------------
// 3. Test-count figures in current-state records
// ---------------------------------------------------------------------------------------------
const floors = JSON.parse(read('scripts/test-minimums.json'));
const byShortName = new Map(
  Object.entries(floors).map(([n, v]) => [n.replace('@pencillift/', ''), v]),
);
const total = Object.values(floors).reduce((a, b) => a + b, 0);
const currentState = records.filter((f) => {
  const tier = classified.get(f) ?? classified.get(f.replace(/^docs\//, ''));
  return tier === 1 || tier === 2;
});
for (const file of currentState) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      // A line that quotes the floors file is asserting the floors, so each figure must be current.
      if (line.includes('scripts/test-minimums.json')) {
        for (const m of line.matchAll(
          /\b(api|db|web|mobile|domain|ai|contracts|ui-tokens)[: ]+([\d,]+)\b/g,
        )) {
          const quoted = Number(m[2].replace(/,/g, ''));
          const actual = byShortName.get(m[1]);
          if (actual !== undefined && quoted !== actual) {
            say(
              `${file}:${i + 1} quotes ${m[1]} ${m[2]} beside scripts/test-minimums.json, but the floor is ${actual}`,
            );
          }
        }
      }
      // A line that states the suite total must state the sum. Corrections quoting a superseded
      // figure read "this said N" or "wrote N" and do not match this shape.
      for (const m of line.matchAll(
        /\*{0,2}([\d,]{4,})\*{0,2}\s+(?:tests? pass|passing tests?)\b/g,
      )) {
        const quoted = Number(m[1].replace(/,/g, ''));
        if (quoted !== total) {
          say(`${file}:${i + 1} states ${m[1]} tests pass, but the eight floors sum to ${total}`);
        }
      }
    });
}

// ---------------------------------------------------------------------------------------------
// 5. Ledger row counts quoted in current-state records
// ---------------------------------------------------------------------------------------------
// A count of an append-only ledger is stale by construction: the next row invalidates it. Three
// records carried one anyway (docs/Source_Of_Truth.md, docs/Beta_Readiness.md,
// docs/Owner_Beta_Checklist.md) and all three were wrong within a day of being written. The right
// place for the figure is docs/Open_Work.md, which is generated; this check stops a hand-written
// one creeping back.
const LEDGER_COUNTS = [
  [
    'docs/Bug_Ledger.md',
    (read('docs/Bug_Ledger.md').match(/^\| BUG-/gm) ?? []).length,
    [
      { pattern: /\b([\d,]{2,})\s+recorded defects\b/g },
      { pattern: /\b([\d,]{2,})\s+defect rows\b/g },
      { pattern: /\b([\d,]{2,})\s+(?:rows|entries)\b/g, generic: true },
    ],
  ],
  [
    'docs/Lessons_Learned.md',
    (read('docs/Lessons_Learned.md').match(/^\| L-\d+/gm) ?? []).length,
    [
      { pattern: /\b([\d,]{2,})\s+lessons\b/g },
      { pattern: /\b([\d,]{2,})\s+(?:rows|entries)\b/g, generic: true },
    ],
  ],
  [
    'docs/Owner_Actions.md',
    (read('docs/Owner_Actions.md').match(/^\| \d+ \|/gm) ?? []).length,
    [
      { pattern: /\b([\d,]{2,})[- ]row register\b/g },
      { pattern: /\b([\d,]{2,})\s+owner actions\b/g },
      { pattern: /\b([\d,]{2,})\s+(?:rows|entries)\b/g, generic: true },
    ],
  ],
];
for (const file of currentState) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      // A figure inside a code span is a QUOTATION of a superseded value, which is how Tier 2
      // corrections are written ("this paragraph said `api 1,219`"). Checking it would make a
      // correct correction impossible, so the convention is: backtick the old figure.
      const assertions = line.replace(/`[^`]*`/g, '``');
      for (const [ledger, actual, phrases] of LEDGER_COUNTS) {
        const name = ledger.replace('docs/', '').replace('.md', '');
        const named = line.includes(ledger) || line.includes(name);
        for (const rx of phrases) {
          // A phrase specific to one ledger counts anywhere; a bare "rows"/"entries" counts only on
          // a line that names the ledger, or every table of numbers in the repository would match.
          if (rx.generic === true && !named) continue;
          for (const m of assertions.matchAll(rx.pattern)) {
            const quoted = Number(m[1].replace(/,/g, ''));
            if (quoted !== actual) {
              say(
                `${file}:${i + 1} says "${m[0].trim()}" of ${name}, which holds ${actual}. A count of ` +
                  'an append-only ledger goes stale with the next row — give the figure as prose-free ' +
                  'as possible, or point at docs/Open_Work.md, which is generated',
              );
            }
          }
        }
      }
    });
}

// ---------------------------------------------------------------------------------------------
// 4. The child PIN spec P3 asks for, and the table that implies it exists
// ---------------------------------------------------------------------------------------------
const PIN_TABLE = 'private.child_pins';
const writers = [];
for (const file of sources) {
  if (file === 'scripts/check-doc-references.mjs' || file.startsWith('docs/')) continue;
  for (const line of read(file).split('\n')) {
    // A purge DELETE and a privilege assertion are not writers of a PIN.
    if (/\b(insert\s+into|update)\s+private\.child_pins\b/i.test(line))
      writers.push(`${file}: ${line.trim()}`);
  }
}
if (writers.length > 0) {
  say(
    `${PIN_TABLE} now has ${writers.length} writer(s), so the child PIN is being built. Finish it rather ` +
      'than leaving it half-reachable: spec P3 wants PIN selection on an already paired device, with ' +
      "hashing against the existing pepper, a rate limit and a lockout like the adult PIN's, a route, a " +
      'screen on both surfaces, docs/Requirement_Coverage.md AC_ACCESS_08 updated and threat T39 ' +
      'resolved. Then delete this check.',
  );
  for (const w of writers) say(`  ${w}`);
}

if (problems.length > 0) {
  console.error('✗ record cross-references');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `✓ record cross-references: ${records.length} records all classified, ${threatRows.size} threat rows all cited correctly, ` +
    `${currentState.length} current-state records agree with the ${total}-test floors, ${PIN_TABLE} still unwritten`,
);

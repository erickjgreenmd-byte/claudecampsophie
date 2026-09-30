import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_STAGES } from '@pencillift/domain/quotas';
import {
  PROPOSED_STAGE_COST_BUDGET_MICROS,
  PROPOSED_STAGE_LIMITS,
  fullRaiseCeiling,
} from './routing.ts';

/**
 * HUNT7-B-2. `docs/Cost_Analysis.md` carries two hand-maintained tables of these constants, and the
 * owner reads them to decide what PencilLift may spend. One row was simply missing: the
 * `thursday_bundle` personalization hold, at 933,600 micro-USD, is the largest single reservation in
 * the product, and the document's worst-case-hold table omitted it and named the daily one (483,240)
 * as the largest — understating the biggest hold by 93%. Nothing could have caught it, because no
 * test related the document to the constants.
 *
 * So this file does. It is deliberately a DOCUMENT test rather than another table: a second copy of
 * the numbers in TypeScript would drift exactly as the markdown did. Every assertion reads the live
 * constant and then looks for that value in the document, so changing a budget without changing the
 * document reds here, and so does deleting a row.
 */
const doc = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'docs', 'Cost_Analysis.md'),
  'utf8',
);

/** How the document writes a micro-USD figure: grouped in threes, as the tables do. */
function grouped(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * The rows of the one markdown table whose header cells are exactly `header`, and nothing else in the
 * document. Both tables in this file carry stage names and micro-USD figures, so a search over the
 * whole document finds the wrong table: the first draft of this test looked for the Thursday hold
 * anywhere in a table line, and DELETING the hold row left the stage table's
 * `| thursday_bundle | 700,000 | 933,600 | 933,600 |` to satisfy it — the very defect the test exists
 * to catch, passing (L-054: a search is only as good as the source it is bounded to).
 */
function tableRows(header: readonly string[]): string[][] {
  const lines = doc.split('\n');
  const cellsOf = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const start = lines.findIndex(
    (l) =>
      l.startsWith('|') &&
      cellsOf(l).length === header.length &&
      cellsOf(l).every((c, i) => c === header[i]),
  );
  if (start < 0) return [];
  const rows: string[][] = [];
  // Skip the header and the |---|---| separator, then take rows until the table ends.
  for (let i = start + 2; i < lines.length && lines[i]!.startsWith('|'); i += 1) {
    rows.push(cellsOf(lines[i]!));
  }
  return rows;
}

const STAGE_TABLE = ['Stage', 'Admission cap', 'Stage budget', 'Full-raise ceiling'] as const;
const HOLD_TABLE = ['Hold', 'Stages summed', 'Micro-USD', 'USD'] as const;

/** The stage table's row for `name`, or null. */
function row(name: string): string[] | null {
  return tableRows(STAGE_TABLE).find((cells) => cells[0] === name) ?? null;
}

describe('[HUNT7-B-2] Cost_Analysis.md states the stage table the code actually runs', () => {
  it('has a row for every stage, with that stage’s real admission cap and budget', () => {
    for (const stage of [...AI_STAGES]) {
      const cells = row(stage);
      expect(cells, `docs/Cost_Analysis.md has no row for the stage '${stage}'`).toBeTruthy();
      const [, cap, budget, ceiling] = cells!;
      expect(cap, stage).toBe(grouped(PROPOSED_STAGE_LIMITS[stage].maxCostMicros));
      expect(budget, stage).toBe(grouped(PROPOSED_STAGE_COST_BUDGET_MICROS[stage]));
      expect(ceiling, stage).toBe(
        grouped(fullRaiseCeiling(stage, PROPOSED_STAGE_LIMITS[stage].maxOutputTokens)),
      );
    }
  });
});

describe('[HUNT7-B-2] Cost_Analysis.md names the largest hold, and names it correctly', () => {
  /**
   * The stages a single `acquireSpendHold` can be taken for, each with the label the document's
   * worst-case-hold table uses for it. `personalizeItems` takes its hold as
   * `acquireSpendHold(deps, PROPOSED_STAGE_COST_BUDGET_MICROS[stage])` where `stage` is
   * `'daily_set' | 'thursday_bundle'`, so BOTH are live single-stage holds — which is the fact the
   * document's table missed.
   */
  const SINGLE_STAGE_HOLDS = ['coaching', 'daily_set', 'thursday_bundle'] as const;

  it('lists each single-stage hold at its budget, Thursday’s included', () => {
    const holds = tableRows(HOLD_TABLE);
    expect(holds.length, 'the worst-case-hold table was not found').toBeGreaterThan(0);
    for (const stage of SINGLE_STAGE_HOLDS) {
      const micros = PROPOSED_STAGE_COST_BUDGET_MICROS[stage];
      // The rows are labelled for a reader, so the pin is that the stage id and its figure meet in
      // ONE row OF THIS TABLE — the 'Stages summed' cell names the stage, the figure cell carries it.
      const found = holds.some(
        (cells) =>
          cells.some((c) => c.includes(stage)) && cells.some((c) => c.includes(grouped(micros))),
      );
      expect(
        found,
        `the worst-case-hold table has no row naming '${stage}' with ${grouped(micros)}`,
      ).toBe(true);
    }
  });

  it('states the true largest hold in prose, not a smaller one', () => {
    const largest = Math.max(
      ...SINGLE_STAGE_HOLDS.map((s) => PROPOSED_STAGE_COST_BUDGET_MICROS[s]),
    );
    const winner = SINGLE_STAGE_HOLDS.find(
      (s) => PROPOSED_STAGE_COST_BUDGET_MICROS[s] === largest,
    )!;
    const claim = doc.split('\n\n').find((para) => /largest single hold/i.test(para));
    expect(claim, 'no paragraph claims which hold is largest').toBeTruthy();
    // The sentence must carry the largest figure...
    expect(claim).toContain(grouped(largest));
    // ...and must not name a SMALLER hold as the largest, which is the defect itself: the paragraph
    // said 483,240 while thursday_bundle reserved 933,600.
    for (const stage of SINGLE_STAGE_HOLDS) {
      if (stage === winner) continue;
      const smaller = grouped(PROPOSED_STAGE_COST_BUDGET_MICROS[stage]);
      const sentence = claim!.split(/(?<=\.)\s/)[0] ?? '';
      expect(sentence, `the "largest hold" sentence names ${stage}'s figure`).not.toContain(
        smaller,
      );
    }
  });
});

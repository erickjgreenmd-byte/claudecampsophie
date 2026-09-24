import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The child rewards screen imports react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read its source. The copy itself is built and tested in
 * child-view-model.ts; here we check the screen shows it (spec P9 "configurable earning rules",
 * AC_REWARDS_01: children see the published family rules).
 */
const screen = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(child)', 'rewards.tsx'),
  'utf8',
);

/** Source without comments, so a comment cannot satisfy a check. */
const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('child rewards screen: “How you earn points”', () => {
  it('shows the heading, every rule line and the note from the view model', () => {
    expect(code).toMatch(/accessibilityRole="header"[^>]*>\s*\{view\.earning\.heading\}/);
    expect(code).toMatch(/view\.earning\.lines\.map\(/);
    expect(code).toMatch(/\{view\.earning\.note\}/);
  });

  it('renders only what the view model prepared (no raw rule numbers or threshold)', () => {
    expect(code).not.toMatch(/earningRules|pointsPerTry|firstTryBonus|minMeaningful/);
  });
});

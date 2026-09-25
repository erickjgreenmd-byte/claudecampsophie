import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@pencillift/ui-tokens';

/**
 * Checks on the portal stylesheet that a DOM test cannot see (jsdom does not apply styles.css).
 *
 * - WEB-R1-03: the primary `.btn` draws 16px bold white text, which is not WCAG "large text", so its
 *   fill must give at least 4.5:1 (WCAG 1.4.3). The approved `--teal` gives 4.07:1; `--teal-text`
 *   gives 5.95:1 and is what the public CtaLink already uses.
 * - WEB-R1-10: the global `input` rule (width 100%, min-height 44px) must not stretch checkboxes and
 *   radios; one rule sizes them back to their natural width.
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

/** Declarations of the rule whose selector list is exactly `selector` (whitespace-normalised). */
function rule(selector: string): Record<string, string> {
  const normalise = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .trim();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => normalise(m[1]!) === normalise(selector),
  );
  expect(matches.length, `styles.css has a rule for ${selector}`).toBeGreaterThan(0);
  const out: Record<string, string> = {};
  for (const m of matches) {
    for (const decl of m[2]!.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

const root = rule(':root');

/** A colour value with `var(--token)` resolved against :root. */
function colour(value: string): string {
  const token = /^var\((--[\w-]+)\)$/.exec(value);
  const resolved = token ? root[token[1]!] : value;
  expect(resolved, `${value} resolves to a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
  return resolved!;
}

describe('WEB-R1-03 primary button text contrast', () => {
  it('white text on the .btn fill is at least 4.5:1 (16px bold is not large text)', () => {
    const btn = rule('.btn');
    expect(btn['font-size']).toBe('1rem');
    const ratio = contrastRatio(colour(btn.color!), colour(btn.background!));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('the button border matches its fill and the secondary button text is also 4.5:1', () => {
    const btn = rule('.btn');
    expect(btn.border).toMatch(new RegExp(`solid ${btn.background!.replace(/[()]/g, '\\$&')}$`));
    const secondary = rule('.btn.secondary');
    expect(
      contrastRatio(colour(secondary.color!), colour(secondary.background!)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the approved teal for non-text accents (brand-bar focus ring, feature cards)', () => {
    expect(rule('.brand-bar a:focus-visible').outline).toBe('3px solid var(--teal)');
    expect(rule('.feature-card')['border-top']).toBe('4px solid var(--teal)');
  });
});

describe('WEB-R1-10 checkboxes and radios are not stretched by the input rule', () => {
  it('one rule gives checkboxes and radios their natural width and a 24px minimum height', () => {
    const toggle = rule("input[type='checkbox'], input[type='radio']");
    expect(toggle.width).toBe('auto');
    expect(toggle['min-height']).toBe('24px');
    // The text-input rule is unchanged.
    const inputs = rule('input, select');
    expect(inputs.width).toBe('100%');
    expect(inputs['min-height']).toBe('44px');
  });
});

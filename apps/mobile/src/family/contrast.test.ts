import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colors, contrastRatio } from '@pencillift/ui-tokens';
import { describe, expect, it } from 'vitest';

/**
 * R2C-MOB-1 (the mobile twin of BUG-145): buttons, selected chips and selected answer choices drew
 * white text on `colors.teal`, which is 4.07:1 — below WCAG AA 4.5:1 for normal-size text. The
 * screens import react-native and cannot render in this suite (see vitest.config.ts), so this
 * reads their style sources. Every fill that is meant to carry light text (it contrasts more with
 * white than with navy) must reach 4.5:1 against white; `colors.teal` stays for borders, icons,
 * focus rings and text-free graphics such as progress fills.
 */
const srcDir = join(import.meta.dirname, '..');
const appDir = join(srcDir, '..', 'app');

/**
 * Every screen and component source in the app (tests excluded), so a new screen that puts light
 * text on `colors.teal` fails here too, not only the files the finding named.
 */
function sourcesUnder(dir: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, sourcesUnder(path, name));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out[name] = path;
  }
  return out;
}

const SOURCES: Record<string, string> = {
  ...sourcesUnder(appDir, 'app'),
  ...sourcesUnder(srcDir, 'src'),
};

/**
 * Style keys whose fill never carries text (progress bars). WCAG 1.4.11 asks 3:1 of these against
 * the surrounding surface, which `colors.teal` meets; they are named here so any other key that
 * fills with a dark colour is held to the text rule.
 */
const TEXT_FREE_FILLS: Record<string, readonly string[]> = {
  'src/learning/player.tsx': ['fill'],
  'app/(child)/scan.tsx': ['progressFill'],
  'app/(child)/rewards.tsx': ['fill'],
};

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

function resolveColour(raw: string, where: string): string {
  const token = /^colors\.(\w+)$/.exec(raw);
  if (token?.[1]) {
    const value = (colors as Record<string, string>)[token[1]];
    if (!value) throw new Error(`${where}: unknown colour token ${raw}`);
    return value;
  }
  const hex = /^'(#[0-9a-fA-F]{6})'$/.exec(raw);
  if (hex?.[1]) return hex[1];
  throw new Error(`${where}: cannot resolve backgroundColor ${raw}; use a brand token`);
}

interface Fill {
  key: string;
  hex: string;
  line: number;
}

/** Every `backgroundColor:` in the file, with the style key (or `<inline>`) that encloses it. */
function fillsIn(source: string, file: string): Fill[] {
  const fills: Fill[] = [];
  const pattern = /backgroundColor:\s*([^,}\n]+)/g;
  for (const match of source.matchAll(pattern)) {
    const at = match.index;
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    // Nearest `name: {` that is still open at this point.
    let depth = 0;
    let key = '<inline>';
    for (let i = before.length - 1; i >= 0; i -= 1) {
      const ch = before[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          const head = /(\w+)\s*:\s*$/.exec(before.slice(0, i));
          if (head?.[1]) key = head[1];
          break;
        }
        depth -= 1;
      }
    }
    const raw = (match[1] ?? '').trim();
    fills.push({ key, hex: resolveColour(raw, `${file}:${line}`), line });
  }
  return fills;
}

const carriesLightText = (hex: string) =>
  contrastRatio(hex, colors.white) > contrastRatio(hex, colors.navy);

describe('light text on teal fills meets WCAG AA (R2C-MOB-1)', () => {
  it('the defect the rule guards against: white on colors.teal is below 4.5:1, tealText is not', () => {
    expect(contrastRatio(colors.white, colors.teal)).toBeLessThan(AA_TEXT);
    expect(contrastRatio(colors.white, colors.tealText)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('scans every screen, the ones the finding named included, and finds their fills', () => {
    for (const named of [
      'src/family/ui.tsx',
      'src/learning/player.tsx',
      'app/(parent)/rewards.tsx',
      'app/(parent)/privacy.tsx',
      'app/(child)/scan.tsx',
      'app/(child)/results.tsx',
      'app/index.tsx',
      'app/(child)/rewards.tsx',
    ]) {
      expect(Object.keys(SOURCES)).toContain(named);
      expect(fillsIn(readFileSync(SOURCES[named]!, 'utf8'), named).length).toBeGreaterThan(0);
    }
  });

  for (const [file, path] of Object.entries(SOURCES)) {
    it(`${file}: every fill behind light text reaches 4.5:1 against white`, () => {
      const source = readFileSync(path, 'utf8');
      const fills = fillsIn(source, file);
      const textFree = TEXT_FREE_FILLS[file] ?? [];
      const failures: string[] = [];
      for (const fill of fills) {
        if (!carriesLightText(fill.hex)) continue;
        const ratio = contrastRatio(fill.hex, colors.white);
        const floor = textFree.includes(fill.key) ? AA_NON_TEXT : AA_TEXT;
        if (ratio < floor) {
          failures.push(`${file}:${fill.line} ${fill.key} ${fill.hex} is ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${file}: the primary button fill is the text teal, not colors.teal`, () => {
      const source = readFileSync(path, 'utf8');
      const fills = fillsIn(source, file).filter((f) => f.key === 'button');
      if (!fills.length) return;
      for (const fill of fills) expect(fill.hex).toBe(colors.tealText);
    });
  }

  it('the text-free exemption only names keys that exist and still meet 3:1', () => {
    for (const [file, keys] of Object.entries(TEXT_FREE_FILLS)) {
      const path = SOURCES[file];
      expect(path, file).toBeDefined();
      const fills = fillsIn(readFileSync(path as string, 'utf8'), file);
      for (const key of keys) {
        const found = fills.filter((f) => f.key === key);
        expect(found.length, `${file} ${key}`).toBeGreaterThan(0);
        for (const f of found) {
          expect(contrastRatio(f.hex, colors.white)).toBeGreaterThanOrEqual(AA_NON_TEXT);
          expect(contrastRatio(f.hex, colors.offWhite)).toBeGreaterThanOrEqual(AA_NON_TEXT);
        }
      }
    }
  });
});

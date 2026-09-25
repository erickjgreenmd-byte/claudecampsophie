import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Labeled mock: react-native cannot run in this Node suite (vitest.config.ts), so `Image` and
 * `View` become plain function components that record what they were given. What is under test is
 * the mark's own props (source, size, accessibility); native rendering needs a device.
 */
const recorded = vi.hoisted(() => ({
  images: [] as Record<string, unknown>[],
  mounted: [] as string[],
}));

vi.mock('react-native', () => ({
  Image: function Image(props: Record<string, unknown>) {
    recorded.images.push(props);
    return null;
  },
  View: function View({ children }: { children?: ReactNode }) {
    return children ?? null;
  },
  StyleSheet: { create: <T>(sheet: T): T => sheet },
}));

// Imported after the mock so the component sees the labeled mock, never the native module.
const { BRAND_HERO_SIZE, BRAND_MARK_SIZES, BrandHero, BrandMark, BrandRow } = await import(
  './BrandMark.tsx'
);

/** Minimal renderer: calls function components and walks their output; hosts are recorded. */
function mount(node: ReactNode): void {
  if (Array.isArray(node)) {
    node.forEach(mount);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function') {
    const component = element.type as ((props: unknown) => ReactNode) & { name: string };
    recorded.mounted.push(component.name);
    mount(component(element.props));
    return;
  }
  recorded.mounted.push(String(element.type));
  mount(element.props.children);
}

function render(element: ReactNode): { images: Record<string, unknown>[]; mounted: string[] } {
  recorded.images.length = 0;
  recorded.mounted.length = 0;
  mount(element);
  return { images: [...recorded.images], mounted: [...recorded.mounted] };
}

describe('BrandMark', () => {
  it('renders the symbol-256 mark labelled "PencilLift" at 36 px (md) by default', () => {
    const [image] = render(createElement(BrandMark)).images;
    expect(image).toBeDefined();
    expect(String(image?.source)).toMatch(/symbol-256\.png$/);
    expect(image?.accessibilityLabel).toBe('PencilLift');
    expect(image?.accessibilityRole).toBe('image');
    expect(image?.accessible).toBe(true);
    expect(image?.accessibilityElementsHidden).toBe(false);
    expect(image?.['aria-hidden']).toBe(false);
    expect(image?.resizeMode).toBe('contain');
    expect(image?.style).toEqual({ width: 36, height: 36 });
  });

  it('offers sm (24) and md (36)', () => {
    expect(BRAND_MARK_SIZES).toEqual({ sm: 24, md: 36 });
    const [small] = render(createElement(BrandMark, { size: 'sm' })).images;
    expect(small?.style).toEqual({ width: 24, height: 24 });
  });

  it('is hidden from assistive technology when decorative (no duplicate brand announcement)', () => {
    const [image] = render(createElement(BrandMark, { decorative: true })).images;
    expect(image?.accessibilityLabel).toBeUndefined();
    expect(image?.accessible).toBe(false);
    expect(image?.accessibilityElementsHidden).toBe(true);
    expect(image?.importantForAccessibility).toBe('no-hide-descendants');
    expect(image?.['aria-hidden']).toBe(true);
  });

  it('BrandRow holds the mark and nothing else', () => {
    const { images, mounted } = render(createElement(BrandRow));
    expect(mounted).toEqual(['BrandRow', 'View', 'BrandMark', 'Image']);
    expect(images).toHaveLength(1);
    expect(images[0]?.accessibilityLabel).toBe('PencilLift');
    expect(images[0]?.style).toEqual({ width: 36, height: 36 });
  });

  it('BrandHero is the large symbol-512, decorative because the text wordmark follows it', () => {
    const [image] = render(createElement(BrandHero)).images;
    expect(String(image?.source)).toMatch(/symbol-512\.png$/);
    expect(image?.accessible).toBe(false);
    expect(image?.accessibilityElementsHidden).toBe(true);
    expect(image?.['aria-hidden']).toBe(true);
    expect(image?.accessibilityLabel).toBeUndefined();
    expect(image?.style).toMatchObject({ width: BRAND_HERO_SIZE, height: BRAND_HERO_SIZE });
    expect(BRAND_HERO_SIZE).toBeGreaterThan(BRAND_MARK_SIZES.md);
  });
});

/**
 * Screens import react-native, which this suite cannot render, so these checks read their source
 * (the pattern of scan-screen.test.ts): every screen shows the mark, either through Screen from
 * ui.tsx or directly.
 */
const appDir = join(import.meta.dirname, '..', '..', 'app');
const uiSource = readFileSync(join(import.meta.dirname, '..', 'family', 'ui.tsx'), 'utf8');

/**
 * Screens another workflow owns at the time of writing; they still need `<BrandRow />` (lead
 * action). Their check is inverted rather than skipped (the CI gate, scripts/assert-test-count.mjs,
 * fails on any skipped test): it asserts the documented gap, so it fails the moment the mark lands
 * and the entry must then be deleted for the normal check to cover that screen again.
 */
const OWNED_ELSEWHERE = new Set<string>();

function screenFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return screenFiles(path);
    return entry.name.endsWith('.tsx') && entry.name !== '_layout.tsx' ? [path] : [];
  });
}

/** Source without comments, so a comment cannot satisfy a check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** True when a screen's source shows the mark: Screen from ui.tsx, or a Brand* component directly. */
function showsMark(file: string): boolean {
  const source = code(readFileSync(file, 'utf8'));
  const usesScreen =
    /from '(\.\.\/)+src\/family\/ui\.tsx'/.test(source) && /<Screen[\s>]/.test(source);
  const usesMark =
    /from '(\.\.\/)+src\/brand\/BrandMark\.tsx'/.test(source) &&
    /<Brand(Row|Hero|Mark)[\s/>]/.test(source);
  return usesScreen || usesMark;
}

describe('logo on every screen', () => {
  it('Screen (ui.tsx) renders the brand row first, then the children, in a 640 px column', () => {
    const ui = code(uiSource);
    expect(ui).toMatch(/import \{ BrandRow \} from '\.\.\/brand\/BrandMark\.tsx'/);
    expect(ui).toMatch(/<View style=\{styles\.column\}>\s*<BrandRow \/>\s*\{children\}/);
    expect(ui).toMatch(/column: \{ width: '100%', maxWidth: 640 \}/);
    expect(ui).toMatch(/content: \{\s*padding: spacing\.md,/);
  });

  const screens = screenFiles(appDir);
  it('finds the route screens', () => {
    expect(screens.length).toBeGreaterThanOrEqual(20);
  });

  it('OWNED_ELSEWHERE names only screens that still exist', () => {
    const names = new Set(screens.map((file) => file.slice(appDir.length + 1)));
    for (const name of OWNED_ELSEWHERE) {
      expect(names.has(name), `${name} is gone: delete its OWNED_ELSEWHERE entry`).toBe(true);
    }
  });

  for (const file of screens) {
    const name = file.slice(appDir.length + 1);
    if (OWNED_ELSEWHERE.has(name)) {
      it(`${name} (owned elsewhere) still lacks the mark; delete its OWNED_ELSEWHERE entry once it lands`, () => {
        expect(
          showsMark(file),
          `${name} now renders the brand mark: delete it from OWNED_ELSEWHERE so the normal check covers it`,
        ).toBe(false);
      });
      continue;
    }
    it(`${name} shows the mark (Screen from ui.tsx, or BrandRow / BrandHero directly)`, () => {
      expect(showsMark(file), `${name} renders the brand mark`).toBe(true);
    });
  }
});

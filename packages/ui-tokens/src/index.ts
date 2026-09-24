/**
 * PencilLift brand tokens (brand/BRAND_GUIDE.md). Hex values are the approved design targets, not
 * sampled raster values. `tealText` is the darker teal used where small text needs higher contrast.
 */
export const colors = {
  navy: '#17324D',
  teal: '#008D87',
  tealText: '#00706B',
  gold: '#FFB84D',
  white: '#FFFFFF',
  offWhite: '#F7F9FB',
  ink: '#17324D',
  muted: '#4A5E72',
  danger: '#B3261E',
  success: '#1E7A46',
} as const;

export const typography = {
  /** Bundle an appropriately licensed rounded sans (Nunito Sans, SIL OFL 1.1) or fall back to system UI. */
  fontFamily: "'Nunito Sans', ui-rounded, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  scale: { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, xxl: 32 },
  weight: { regular: 400, semibold: 600, bold: 800 },
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

export const radii = { sm: 6, md: 12, lg: 20, pill: 999 } as const;

/** Minimum touch target in density-independent pixels (WCAG 2.5.5 / platform guidance). */
export const minTouchTarget = 44;

export const brand = {
  name: 'PencilLift',
  spokenName: 'Pencil Lift',
  domain: 'PencilLift.com',
  tagline: 'Turn homework into progress.',
} as const;

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Expected #RRGGBB colour, received ${hex}`);
  const value = match[1];
  const channel = (offset: number): number => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

import { describe, expect, it } from 'vitest';
import { colors, contrastRatio } from './index.ts';

describe('brand token contrast', () => {
  it('navy body text on white meets WCAG AA for normal text', () => {
    expect(contrastRatio(colors.navy, colors.white)).toBeGreaterThanOrEqual(4.5);
  });

  it('small teal text uses the darker teal that meets WCAG AA on white', () => {
    expect(contrastRatio(colors.tealText, colors.white)).toBeGreaterThanOrEqual(4.5);
  });

  it('documents that the approved teal alone is only suitable for large text / UI components', () => {
    const ratio = contrastRatio(colors.teal, colors.white);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it('white text on the primary teal button meets large-text AA', () => {
    expect(contrastRatio(colors.white, colors.teal)).toBeGreaterThanOrEqual(3);
  });
});

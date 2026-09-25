/**
 * PencilLift logo, served from the traced brand vectors in apps/web/public/brand (see
 * brand/ASSETS.md: traced from brand/approved_logo_reference.png, a faithful trace rather than an
 * exact copy).
 *
 * - `header` (default): the horizontal lockup without the tagline at a fixed 36 px height. Below
 *   420 px the `<source>` media query swaps in the symbol-only mark so the wordmark never squeezes
 *   the navigation; the tagline never appears at this size (brand guide: no tagline in small
 *   marks).
 * - `hero`: the full lockup with the tagline, fluid width (styles.css `.logo-hero`).
 *
 * Every variant carries explicit `width`/`height` attributes matching the asset's aspect ratio so
 * the browser reserves the box before the SVG arrives and nothing shifts.
 */
import type { ImgHTMLAttributes } from 'react';

/** Brand vectors under apps/web/public/brand; sizes are the SVG viewBoxes in board pixels. */
export const BRAND_ASSETS = {
  lockup: { src: '/brand/lockup.svg', width: 1620, height: 430 },
  lockupNoTagline: { src: '/brand/lockup-no-tagline.svg', width: 1620, height: 430 },
  symbol: { src: '/brand/symbol.svg', width: 540, height: 430 },
} as const;

/** Header logo height in CSS px (styles.css `.logo img` uses the same value). */
export const HEADER_LOGO_HEIGHT = 36;

/** Viewport width below which the header shows the symbol only. */
export const SYMBOL_ONLY_MAX_WIDTH = '(max-width: 419.98px)';

/** Width at `height` that keeps the asset's aspect ratio, rounded to whole CSS pixels. */
function widthAt(asset: { width: number; height: number }, height: number): number {
  return Math.round((asset.width / asset.height) * height);
}

export type LogoVariant = 'header' | 'hero';

export function Logo({
  variant = 'header',
  ...imgProps
}: { variant?: LogoVariant } & Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'alt' | 'width' | 'height' | 'srcSet'
>) {
  if (variant === 'hero') {
    // The tagline is inside the artwork; the page's h1 carries the same words as text, so the
    // alt names the brand only and nothing is announced twice.
    const { lockup } = BRAND_ASSETS;
    return (
      <img
        {...imgProps}
        className={['logo-hero', imgProps.className].filter(Boolean).join(' ')}
        src={lockup.src}
        alt="PencilLift"
        width={lockup.width}
        height={lockup.height}
      />
    );
  }
  const { lockupNoTagline, symbol } = BRAND_ASSETS;
  return (
    <picture className="logo">
      <source
        media={SYMBOL_ONLY_MAX_WIDTH}
        srcSet={symbol.src}
        width={widthAt(symbol, HEADER_LOGO_HEIGHT)}
        height={HEADER_LOGO_HEIGHT}
      />
      <img
        {...imgProps}
        src={lockupNoTagline.src}
        alt="PencilLift"
        width={widthAt(lockupNoTagline, HEADER_LOGO_HEIGHT)}
        height={HEADER_LOGO_HEIGHT}
      />
    </picture>
  );
}

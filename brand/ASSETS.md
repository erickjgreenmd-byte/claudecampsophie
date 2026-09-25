# PencilLift brand assets

Source of truth: `brand/approved_logo_reference.png` (unchanged; see `brand/BRAND_GUIDE.md`). Everything
below is **derived** from it. The SVGs in `brand/assets/` were traced from the reference with
imagetracerjs on 2026-09-25 and their colours snapped to the brand palette (navy `#17324D`, teal
`#008D87`, gold `#FFB84D`, white `#FFFFFF`). They are a faithful trace, **not an exact copy**: raster
stair-steps on curved edges become visible at about 3x zoom, and the star's points are marginally
rounder than the reference. Pixel agreement of the trace against its reference crop (nearest brand
colour per pixel, 1:1): symbol 99.6 %, wordmark 99.2 %, tagline 96.6 %, lockup 99.2 %; the remaining
mismatch is edge anti-aliasing in the raster. The reference's own small teal app-icon mockup is a cue
only; no icon here contains the presentation board or the tagline.

Regenerate every export and the review sheets, then verify them:

```sh
node scripts/brand/export-assets.mjs           # render with headless Chromium, then verify
node scripts/brand/export-assets.mjs --check   # verify the committed files only (no browser)
```

The script header documents the browser variables (`PLAYWRIGHT_CORE_PATH`, `PLAYWRIGHT_CHROMIUM`).
Renders are deterministic on a given Chromium build (the 14 PNGs were byte-identical across two
runs); each PNG is drawn straight from the SVG at its final size, never resampled from a larger PNG.

## Inventory

### Vector sources, `brand/assets/`

| File | Purpose | viewBox (board px) | Background | Derived from |
| --- | --- | --- | --- | --- |
| `symbol.svg` | Pencil-rocket symbol: nose, tip, fins, flame, trail, star | 540 x 430 | transparent | reference crop (80,100) 540x430 |
| `symbol-on-teal.svg` | Same shapes with teal recoloured white, for a teal tile (the board's icon cue) | 540 x 430 | transparent | `symbol.svg` (teal → white) |
| `wordmark.svg` | "PencilLift" outlined; "Pencil" navy, "Lift" teal | 1140 x 240 | transparent | reference crop (560,215) 1140x240 |
| `tagline.svg` | "Turn homework into progress." outlined, navy; never in an icon | 1040 x 72 | transparent | reference crop (560,455) 1040x72 |
| `lockup.svg` | Horizontal lockup: symbol + wordmark + tagline | 1620 x 430 | transparent | the three above, placed as on the board |
| `lockup-no-tagline.svg` | Horizontal lockup without the tagline | 1620 x 430 | transparent | symbol + wordmark |

Each SVG carries a header comment naming the reference, the tracing tool, the palette snap and the
date. Board pixels are reference-image pixels, so the lockup composes the parts at 1:1.

### Mobile, `apps/mobile/assets/brand/` (wired from `apps/mobile/app.config.ts`)

| File | Purpose | Dimensions | Background | Derived from | Bytes |
| --- | --- | --- | --- | --- | --- |
| `icon-ios-1024.png` | iOS app icon: teal tile, white rocket at 70 % width; square corners (the platform masks) | 1024 x 1024 | opaque `#008D87` | `symbol-on-teal.svg` | 34,204 |
| `icon-ios-light-1024.png` | Alternative iOS icon for the owner: white tile, full-colour symbol | 1024 x 1024 | opaque `#FFFFFF` | `symbol.svg` | 32,654 |
| `adaptive-foreground-1024.png` | Android adaptive-icon foreground; symbol inside the 66 dp safe circle; pair with `backgroundColor: "#008D87"` | 1024 x 1024 | transparent | `symbol-on-teal.svg` | 25,131 |
| `adaptive-monochrome-1024.png` | Android adaptive-icon monochrome layer (themed icons): white silhouette | 1024 x 1024 | transparent | `symbol.svg` (all fills white) | 22,213 |
| `splash-1200.png` | expo-splash-screen image: full-colour symbol above the wordmark; `backgroundColor "#F7F9FB"`, `imageWidth` ~220 | 1200 x 1200 | transparent | `symbol.svg` + `wordmark.svg` | 52,350 |
| `splash-dark-1200.png` | Dark splash for a `#17324D` ground: navy in the wordmark **and in the symbol** (fins, tip, collar) becomes white, otherwise those parts vanish on navy | 1200 x 1200 | transparent | `symbol.svg` + `wordmark.svg` (navy → white) | 47,408 |
| `symbol-256.png` | In-app mark, full colour | 256 x 256 (symbol 256 x 204, centred) | transparent | `symbol.svg` | 10,992 |
| `symbol-512.png` | In-app mark, full colour, large | 512 x 512 (symbol 512 x 408, centred) | transparent | `symbol.svg` | 22,118 |
| `symbol-on-teal-256.png` | In-app teal tile mark (round the corners in the app if wanted) | 256 x 256 | opaque `#008D87` | `symbol-on-teal.svg` | 7,869 |

### Web, `apps/web/public/` (served at `/`)

| File | Purpose | Dimensions | Background | Derived from | Bytes |
| --- | --- | --- | --- | --- | --- |
| `favicon.svg` | Favicon (symbol, scalable) | 540 x 430 viewBox | transparent | copy of `symbol.svg` | 4,459 |
| `favicon-32.png` | Favicon fallback | 32 x 32 | transparent | `symbol.svg` | 1,132 |
| `favicon-16.png` | Favicon fallback, small | 16 x 16 | transparent | `symbol.svg` | 504 |
| `apple-touch-icon-180.png` | Apple touch icon: teal tile, white rocket | 180 x 180 | opaque `#008D87` | `symbol-on-teal.svg` | 5,456 |
| `icon-192.png` | Web-manifest icon (`any` and `maskable`) | 192 x 192 | opaque `#008D87` | `symbol-on-teal.svg` | 5,853 |
| `icon-512.png` | Web-manifest icon, large (`any` and `maskable`) | 512 x 512 | opaque `#008D87` | `symbol-on-teal.svg` | 16,270 |
| `manifest.webmanifest` | `name` PencilLift, `theme_color #008D87`, `background_color #F7F9FB`, icons 192/512 | – | – | written by the script | 717 |
| `brand/symbol.svg`, `brand/wordmark.svg`, `brand/lockup.svg`, `brand/lockup-no-tagline.svg` | In-app vector marks (`<img src="/brand/lockup.svg">`) | as the sources | transparent | verbatim copies of `brand/assets/*.svg` | 4,459 / 6,628 / 19,002 / 10,631 |

### Review sheets, `brand/assets/review/` (documentation, regenerated by the script)

| File | Shows | Dimensions | Bytes |
| --- | --- | --- | --- |
| `trace-vs-reference.png` | Each traced SVG beside its crop of the reference, plus the SVGs at 240/160/96 px and the symbol down to 16 px | 1120 x 1116 | 340,350 |
| `icon-masks.png` | Every icon in circle, squircle and rounded-square masks at 48 px and 96 px (adaptive layers over their ground, 108 dp layer with the 72 dp region shown) | 1120 x 1051 | 157,566 |
| `splash-and-favicons.png` | Splash art at `imageWidth` 220 on `#F7F9FB` and `#17324D`, favicons on light and dark tab strips, the in-app marks | 1120 x 1103 | 97,912 |

All listed files together: 957 KB (budget 3 MB). The review sheets carry system-font labels, so
they can differ by a few bytes between machines; the 14 asset PNGs do not.

## Geometry and the mask checks

- **Opaque tiles** (`icon-ios-1024`, `icon-ios-light-1024`, `apple-touch-icon-180`, `icon-192`,
  `icon-512`, `symbol-on-teal-256`): symbol at 70 % of the tile width, nudged 0.4 % toward its trail.
  The script measures the rendered pixels: content reaches at most 39.6 % of the width from the
  centre, inside the 40 % safe radius that maskable web icons and the platform masks share. Every
  tile was rendered at 48 px in circle, squircle and rounded-square masks (`icon-masks.png`): nothing
  clipped, the star present in each.
- **Android adaptive layers**: 108 dp square; content within the 66 dp safe circle (radius 30.6 % of
  the width). Measured: 26.9 %. The masked 72 dp region shows the symbol at about 72 % of its width,
  matching the iOS tile.
- **Splash**: 1200 px square, symbol at 60 % width above the wordmark at 73 % width; at `imageWidth`
  220 the wordmark is 161 px wide on the device.
- **Favicons**: the transparent symbol, so the PNG fallbacks match `favicon.svg`; at 16 px the star is a
  two-pixel dot and the trail a thin stroke (see `splash-and-favicons.png` on both tab strips). If a
  teal tile reads better in the tab strip, render `tile(16/32, TEAL, symbolOnTeal())` instead.
- **Tagline**: appears only in `tagline.svg` and `lockup.svg`; no icon or splash contains it.

## Wiring (files owned by the app leads)

`apps/mobile/app.config.ts`:

```ts
icon: './assets/brand/icon-ios-1024.png',
android: { adaptiveIcon: { foregroundImage: './assets/brand/adaptive-foreground-1024.png',
  monochromeImage: './assets/brand/adaptive-monochrome-1024.png', backgroundColor: '#008D87' } },
plugins: [['expo-splash-screen', { image: './assets/brand/splash-1200.png', imageWidth: 220,
  resizeMode: 'contain', backgroundColor: '#F7F9FB',
  dark: { image: './assets/brand/splash-dark-1200.png', backgroundColor: '#17324D' } }]],
```

`apps/web/index.html` head:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#008D87" />
```

## Licences

- **Artwork** (the reference, the traced SVGs and every export): the owner's; PencilLift brand
  material, not open-licensed. Keep it inside this product.
- **imagetracerjs** (the tracing tool that produced the SVG paths): MIT, © András Jankovics. Not a
  runtime dependency; it ran once at tracing time and is not bundled.
- **playwright-core / Chromium** (the renderer used by `scripts/brand/export-assets.mjs`): Apache-2.0
  (Playwright) and BSD-3-Clause (Chromium). Build-time only; not bundled.
- No typeface is bundled or claimed: the wordmark and tagline are outlined paths traced from the
  reference (the brand guide's rule that the generated wordmark is not attributed to a specific font).

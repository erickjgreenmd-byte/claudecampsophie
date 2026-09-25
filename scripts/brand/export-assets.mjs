#!/usr/bin/env node
// PencilLift brand asset export (brand/BRAND_GUIDE.md, "Production assets the builder must create").
//
// Renders the committed PNG app icons, adaptive-icon layers, splash art, favicons and manifest icons
// from the traced SVG sources in brand/assets/ with headless Chromium, copies the SVGs the web app
// serves, writes apps/web/public/manifest.webmanifest and the review sheets in brand/assets/review/,
// then verifies every output (pixel dimensions, opaque/transparent, icon safe zones, size budget).
// The inventory lives in brand/ASSETS.md.
//
//   node scripts/brand/export-assets.mjs           # render everything, then verify
//   node scripts/brand/export-assets.mjs --check   # verify the committed files only (no browser)
//
// Browser resolution (never run "playwright install" for this; point at an existing install):
//   PLAYWRIGHT_CORE_PATH   directory that contains playwright-core (a node_modules directory or the
//                          package directory itself). Fallback: this workspace's scratch install.
//   PLAYWRIGHT_CHROMIUM    Chromium executable. Fallback: /opt/pw-browsers/chromium-1194/chrome-linux/chrome
//
// Determinism: every PNG is rendered straight from the SVG at its final pixel size (device scale
// factor 1, integer placement, no resampling of a larger PNG), so a re-run on the same Chromium
// build reproduces the files byte for byte. The review sheets carry text labels in the system font
// and may differ between machines; they are documentation, not shipped assets.
/* global document */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const SOURCES = path.join(root, 'brand/assets');
const MOBILE = path.join(root, 'apps/mobile/assets/brand');
const WEB = path.join(root, 'apps/web/public');
const REVIEW = path.join(root, 'brand/assets/review');
/** Store listing graphics (Play feature graphic, Amazon icons); not shipped in any app bundle. */
const STORE = path.join(root, 'brand/store');
const REFERENCE = path.join(root, 'brand/approved_logo_reference.png');

const NAVY = '#17324D';
const TEAL = '#008D87';
const GOLD = '#FFB84D';
const WHITE = '#FFFFFF';
const OFF_WHITE = '#F7F9FB';

// Traced sources, in board pixels (the viewBox of each SVG).
const SYMBOL = { w: 540, h: 430 };
const WORDMARK = { w: 1140, h: 240 };

// Opaque tiles (iOS icon, apple-touch-icon, manifest icons, in-app teal mark): the symbol spans 70 %
// of the tile and sits 0.4 % toward its trail, which keeps every content pixel (the star's right
// point is the extreme) inside the 40 %-radius safe zone that maskable web icons and the platform
// masks (circle, squircle, rounded square) share. The platforms add their own corner rounding.
const TILE_SYMBOL_WIDTH = 0.7;
const TILE_NUDGE = 0.004;
const MASKABLE_SAFE_RADIUS = 0.4;

// Android adaptive icon layers are 108 dp with a 66 dp safe circle; at 1024 px that circle is
// 626 px across. The symbol's extreme points lie on its diagonal, so fitting the bounding box's
// diagonal to the circle keeps the whole mark inside it (0.47 leaves a 1 % margin for edge pixels).
const ADAPTIVE_SAFE_RADIUS = 66 / 108 / 2;
const ADAPTIVE_SYMBOL_WIDTH = 0.47;

// Reference crops used by the review sheet, in pixels of brand/approved_logo_reference.png.
const REFERENCE_CROPS = {
  // The wordmark's "P" starts inside the symbol's rectangle (the star reaches past it), so the
  // review sheet covers that edge; `cover` is in crop-local pixels.
  symbol: { x: 80, y: 100, w: 540, h: 430, cover: { x: 492, y: 138, w: 48, h: 292 } },
  wordmark: { x: 560, y: 215, w: 1140, h: 240 },
  tagline: { x: 560, y: 455, w: 1040, h: 72 },
  lockup: { x: 80, y: 100, w: 1620, h: 430 },
};

const SIZE_BUDGET_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// SVG sources and compositions
// ---------------------------------------------------------------------------------------------

const svgCache = new Map();
function svgSource(name) {
  if (!svgCache.has(name)) svgCache.set(name, readFileSync(path.join(SOURCES, `${name}.svg`), 'utf8'));
  return svgCache.get(name);
}

/** Replace brand fills (`fill="#RRGGBB"`) according to `map`, e.g. { [NAVY]: WHITE }. */
function recolor(svg, map) {
  return svg.replace(/fill="(#[0-9A-Fa-f]{6})"/g, (m, hex) => {
    const to = map[hex.toUpperCase()];
    return to ? `fill="${to}"` : m;
  });
}

const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

function img(svg, x, y, w, h) {
  const style = `position:absolute;left:${Math.round(x)}px;top:${Math.round(y)}px;width:${Math.round(w)}px;height:${Math.round(h)}px`;
  return `<img src="${dataUri(svg)}" style="${style}" alt="">`;
}

function page(w, h, background, body) {
  const bg = background ? `background:${background}` : 'background:transparent';
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;${bg}}body{position:relative;width:${w}px;height:${h}px;overflow:hidden}</style></head><body>${body}</body></html>`;
}

/** Symbol centred on an opaque tile; `symbol` is the SVG text to place. */
function tile(size, background, symbol) {
  const w = size * TILE_SYMBOL_WIDTH;
  const h = (w * SYMBOL.h) / SYMBOL.w;
  const nudge = size * TILE_NUDGE;
  return page(size, size, background, img(symbol, (size - w) / 2 - nudge, (size - h) / 2 + nudge, w, h));
}

/** Symbol fitted to a transparent square. */
function transparentSymbol(size, symbol) {
  const h = (size * SYMBOL.h) / SYMBOL.w;
  return page(size, size, null, img(symbol, 0, (size - h) / 2, size, h));
}

/** Android adaptive layer: symbol inside the 66 dp safe circle of a transparent 108 dp square. */
function adaptiveLayer(size, symbol) {
  const w = size * ADAPTIVE_SYMBOL_WIDTH;
  const h = (w * SYMBOL.h) / SYMBOL.w;
  return page(size, size, null, img(symbol, (size - w) / 2, (size - h) / 2, w, h));
}

/** Store feature graphic: the full lockup centred on an opaque off-white banner (Play 1024x500). */
function feature(w, h, lockup) {
  const lw = w * 0.72;
  const lh = (lw * 430) / 1620;
  return page(w, h, OFF_WHITE, img(lockup, (w - lw) / 2, (h - lh) / 2, lw, lh));
}

/** Splash art: symbol above the wordmark on a transparent square (expo-splash-screen image). */
function splash(size, symbol, wordmark) {
  const sw = size * 0.6;
  const sh = (sw * SYMBOL.h) / SYMBOL.w;
  const ww = size * (880 / 1200);
  const wh = (ww * WORDMARK.h) / WORDMARK.w;
  const gap = size * (56 / 1200);
  const top = (size - (sh + gap + wh)) / 2;
  return page(
    size,
    size,
    null,
    img(symbol, (size - sw) / 2, top, sw, sh) + img(wordmark, (size - ww) / 2, top + sh + gap, ww, wh),
  );
}

const symbol = () => svgSource('symbol');
const symbolOnTeal = () => svgSource('symbol-on-teal');
const symbolWhite = () => recolor(svgSource('symbol'), { [NAVY]: WHITE, [TEAL]: WHITE, [GOLD]: WHITE });
// Dark splash: the wordmark's navy becomes white for the navy ground; the symbol's navy parts
// (fins, graphite tip, collar) would vanish on that ground, so they become white as well.
const symbolForNavy = () => recolor(svgSource('symbol'), { [NAVY]: WHITE });
const wordmark = () => svgSource('wordmark');
const wordmarkForNavy = () => recolor(svgSource('wordmark'), { [NAVY]: WHITE });

/**
 * Every rendered PNG. `check` runs on the decoded pixels after rendering (and in --check mode).
 *   opaque: true → every pixel alpha 255; false → transparent corners.
 *   safe: content must stay within this radius (fraction of width) of the centre.
 */
const PNG_EXPORTS = [
  {
    file: path.join(MOBILE, 'icon-ios-1024.png'),
    size: 1024,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(1024, TEAL, symbolOnTeal()),
    purpose: 'iOS app icon (opaque, teal tile, white rocket; the platform rounds the corners)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(MOBILE, 'icon-ios-light-1024.png'),
    size: 1024,
    opaque: true,
    ground: WHITE,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(1024, WHITE, symbol()),
    purpose: 'Alternative iOS app icon for the owner (opaque white tile, full-colour symbol)',
    from: 'symbol.svg',
  },
  {
    file: path.join(MOBILE, 'adaptive-foreground-1024.png'),
    size: 1024,
    opaque: false,
    safe: ADAPTIVE_SAFE_RADIUS,
    html: () => adaptiveLayer(1024, symbolOnTeal()),
    purpose: 'Android adaptive icon foreground (transparent; pair with backgroundColor #008D87)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(MOBILE, 'adaptive-monochrome-1024.png'),
    size: 1024,
    opaque: false,
    safe: ADAPTIVE_SAFE_RADIUS,
    html: () => adaptiveLayer(1024, symbolWhite()),
    purpose: 'Android adaptive icon monochrome layer (white silhouette, transparent; themed icons)',
    from: 'symbol.svg (all fills white)',
  },
  {
    file: path.join(MOBILE, 'splash-1200.png'),
    size: 1200,
    opaque: false,
    html: () => splash(1200, symbol(), wordmark()),
    purpose: 'Splash art for expo-splash-screen (backgroundColor #F7F9FB, imageWidth ~220)',
    from: 'symbol.svg + wordmark.svg',
  },
  {
    file: path.join(MOBILE, 'splash-dark-1200.png'),
    size: 1200,
    opaque: false,
    html: () => splash(1200, symbolForNavy(), wordmarkForNavy()),
    purpose: 'Dark splash art for a #17324D ground (navy in the wordmark and symbol becomes white)',
    from: 'symbol.svg + wordmark.svg (navy → white)',
  },
  {
    file: path.join(MOBILE, 'symbol-256.png'),
    size: 256,
    opaque: false,
    html: () => transparentSymbol(256, symbol()),
    purpose: 'In-app mark (full colour, transparent square)',
    from: 'symbol.svg',
  },
  {
    file: path.join(MOBILE, 'symbol-512.png'),
    size: 512,
    opaque: false,
    html: () => transparentSymbol(512, symbol()),
    purpose: 'In-app mark, large (full colour, transparent square)',
    from: 'symbol.svg',
  },
  {
    file: path.join(MOBILE, 'symbol-on-teal-256.png'),
    size: 256,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(256, TEAL, symbolOnTeal()),
    purpose: 'In-app teal tile mark (opaque; round the corners in the app if wanted)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(STORE, 'amazon-icon-114.png'),
    size: 114,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(114, TEAL, symbolOnTeal()),
    purpose: 'Amazon Appstore small icon (opaque teal tile)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(STORE, 'amazon-icon-512.png'),
    size: 512,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(512, TEAL, symbolOnTeal()),
    purpose: 'Amazon Appstore large icon (opaque teal tile)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(STORE, 'feature-graphic-1024x500.png'),
    size: 1024,
    width: 1024,
    height: 500,
    opaque: true,
    ground: OFF_WHITE,
    html: () => feature(1024, 500, svgSource('lockup')),
    purpose: 'Google Play feature graphic (opaque off-white banner with the full lockup)',
    from: 'lockup.svg',
  },
  {
    file: path.join(WEB, 'favicon-32.png'),
    size: 32,
    opaque: false,
    html: () => transparentSymbol(32, symbol()),
    purpose: 'Favicon fallback (transparent symbol)',
    from: 'symbol.svg',
  },
  {
    file: path.join(WEB, 'favicon-16.png'),
    size: 16,
    opaque: false,
    html: () => transparentSymbol(16, symbol()),
    purpose: 'Favicon fallback, small (transparent symbol)',
    from: 'symbol.svg',
  },
  {
    file: path.join(WEB, 'apple-touch-icon-180.png'),
    size: 180,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(180, TEAL, symbolOnTeal()),
    purpose: 'Apple touch icon (opaque teal tile, white rocket)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(WEB, 'icon-192.png'),
    size: 192,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(192, TEAL, symbolOnTeal()),
    purpose: 'Web manifest icon (opaque teal tile, white rocket; any + maskable)',
    from: 'symbol-on-teal.svg',
  },
  {
    file: path.join(WEB, 'icon-512.png'),
    size: 512,
    opaque: true,
    ground: TEAL,
    safe: MASKABLE_SAFE_RADIUS,
    html: () => tile(512, TEAL, symbolOnTeal()),
    purpose: 'Web manifest icon, large (opaque teal tile, white rocket; any + maskable)',
    from: 'symbol-on-teal.svg',
  },
];

/** SVG copies the web app serves, verbatim from brand/assets. */
const SVG_COPIES = [
  { file: path.join(WEB, 'favicon.svg'), from: 'symbol' },
  { file: path.join(WEB, 'brand/symbol.svg'), from: 'symbol' },
  { file: path.join(WEB, 'brand/lockup.svg'), from: 'lockup' },
  { file: path.join(WEB, 'brand/lockup-no-tagline.svg'), from: 'lockup-no-tagline' },
  { file: path.join(WEB, 'brand/wordmark.svg'), from: 'wordmark' },
];

const MANIFEST = {
  file: path.join(WEB, 'manifest.webmanifest'),
  json: {
    name: 'PencilLift',
    short_name: 'PencilLift',
    description: 'Turn homework into progress.',
    start_url: '/',
    display: 'standalone',
    theme_color: TEAL,
    background_color: OFF_WHITE,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
};

const REVIEW_SHEETS = ['trace-vs-reference.png', 'icon-masks.png', 'splash-and-favicons.png'];

// ---------------------------------------------------------------------------------------------
// Review sheets (brand/assets/review/)
// ---------------------------------------------------------------------------------------------

const pngUri = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

function referenceCrop(name, width) {
  const c = REFERENCE_CROPS[name];
  const s = width / c.w;
  const referenceWidth = 1774;
  const referenceHeight = 887;
  const cover = c.cover
    ? `<div style="position:absolute;left:${c.cover.x * s}px;top:${c.cover.y * s}px;width:${c.cover.w * s}px;height:${c.cover.h * s}px;background:#fff"></div>`
    : '';
  return `<div style="width:${width}px;height:${Math.round(c.h * s)}px;overflow:hidden;position:relative;background:#fff"><img src="${pngUri(REFERENCE)}" style="position:absolute;left:${-c.x * s}px;top:${-c.y * s}px;width:${referenceWidth * s}px;height:${referenceHeight * s}px" alt="">${cover}</div>`;
}

function sheetStyle() {
  return `body{margin:0;background:${OFF_WHITE};font:12px system-ui,sans-serif;color:#333}.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:6px 0 14px}h2{font-size:13px;margin:10px 0 2px}.cap{font-size:11px;color:#555;text-align:center;margin-top:2px}`;
}

function traceSheet() {
  const w = 400;
  const small = (name, h, sizes) =>
    sizes
      .map(
        (s) =>
          `<div><img src="${dataUri(svgSource(name))}" style="width:${s}px;height:${Math.round((h * s) / (name === 'symbol' ? 540 : name === 'wordmark' ? 1140 : name === 'tagline' ? 1040 : 1620))}px" alt=""><div class="cap">${s}px</div></div>`,
      )
      .join('');
  let body = '<div style="padding:10px;width:1100px">';
  body += `<h2>Traced SVG (right) beside its crop of brand/approved_logo_reference.png (left), then the SVG at small sizes on off-white. A trace, not an exact copy.</h2>`;
  for (const [name, h] of [
    ['symbol', 430],
    ['wordmark', 240],
    ['tagline', 72],
    ['lockup', 430],
  ]) {
    const sizes = name === 'symbol' ? [96, 48, 32, 16] : [240, 160, 96];
    body += `<div class="row"><div>${referenceCrop(name, w)}<div class="cap">reference crop: ${name}${REFERENCE_CROPS[name].cover ? ' (wordmark edge covered)' : ''}</div></div><div><img src="${dataUri(svgSource(name))}" style="width:${w}px" alt=""><div class="cap">brand/assets/${name}.svg</div></div>${small(name, h, sizes)}</div>`;
  }
  body += `<div class="row"><div><img src="${dataUri(svgSource('lockup-no-tagline'))}" style="width:${w}px" alt=""><div class="cap">brand/assets/lockup-no-tagline.svg</div></div><div><img src="${dataUri(svgSource('symbol-on-teal'))}" style="width:180px;background:${TEAL};padding:24px" alt=""><div class="cap">symbol-on-teal.svg on #008D87</div></div></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${sheetStyle()}</style></head><body>${body}</body></html>`;
}

/** CSS clip-path polygon of a superellipse (|x|^n + |y|^n = 1), the usual "squircle". */
function squirclePolygon(n = 5, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = Math.sign(s) * Math.abs(s) ** (2 / n);
    pts.push(`${(50 + 50 * x).toFixed(2)}% ${(50 + 50 * y).toFixed(2)}%`);
  }
  return `polygon(${pts.join(',')})`;
}

const MASKS = [
  ['circle', 'clip-path:circle(50% at 50% 50%)'],
  ['squircle', `clip-path:${squirclePolygon()}`],
  ['rounded square', 'border-radius:22%;overflow:hidden'],
];

function masked(uri, size, mask, ground, layerScale = 1) {
  const layer = size * layerScale;
  const off = (size - layer) / 2;
  return `<div style="width:${size}px;height:${size}px;position:relative;overflow:hidden;background:${ground};${mask}"><img src="${uri}" style="position:absolute;left:${off}px;top:${off}px;width:${layer}px;height:${layer}px" alt=""></div>`;
}

function maskSheet() {
  const icons = [
    ['icon-ios-1024.png', path.join(MOBILE, 'icon-ios-1024.png'), 'transparent', 1],
    ['icon-ios-light-1024.png', path.join(MOBILE, 'icon-ios-light-1024.png'), 'transparent', 1],
    ['adaptive-foreground-1024.png over #008D87 (108 dp layer, 72 dp shown)', path.join(MOBILE, 'adaptive-foreground-1024.png'), TEAL, 108 / 72],
    ['adaptive-monochrome-1024.png over navy (108 dp layer, 72 dp shown)', path.join(MOBILE, 'adaptive-monochrome-1024.png'), NAVY, 108 / 72],
    ['apple-touch-icon-180.png', path.join(WEB, 'apple-touch-icon-180.png'), 'transparent', 1],
    ['icon-192.png', path.join(WEB, 'icon-192.png'), 'transparent', 1],
    ['icon-512.png', path.join(WEB, 'icon-512.png'), 'transparent', 1],
    ['symbol-on-teal-256.png', path.join(MOBILE, 'symbol-on-teal-256.png'), 'transparent', 1],
  ];
  let body = '<div style="padding:10px;width:1100px">';
  body += '<h2>Every icon in the circle, squircle and rounded-square masks at 48 px (then 96 px). Look for clipping and for the star.</h2>';
  for (const [label, file, ground, scale] of icons) {
    const uri = pngUri(file);
    body += `<div class="row"><div style="width:330px">${label}</div>`;
    for (const size of [48, 96]) {
      for (const [maskName, mask] of MASKS) {
        body += `<div>${masked(uri, size, mask, ground, scale)}<div class="cap">${maskName} ${size}</div></div>`;
      }
    }
    body += '</div>';
  }
  body += '</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${sheetStyle()}</style></head><body>${body}</body></html>`;
}

function splashSheet() {
  const light = pngUri(path.join(MOBILE, 'splash-1200.png'));
  const dark = pngUri(path.join(MOBILE, 'splash-dark-1200.png'));
  const phone = (uri, ground, w) =>
    `<div style="width:${w}px;height:${Math.round(w * 2.1)}px;background:${ground};display:flex;align-items:center;justify-content:center;border-radius:18px"><img src="${uri}" style="width:220px" alt=""></div>`;
  const strip = (ground, text) =>
    `<div style="display:flex;gap:16px;align-items:center;background:${ground};color:${text};padding:8px 12px;border-radius:6px">` +
    [
      ['favicon-16.png', pngUri(path.join(WEB, 'favicon-16.png')), 16],
      ['favicon-32.png', pngUri(path.join(WEB, 'favicon-32.png')), 32],
      ['favicon.svg @16', dataUri(svgSource('symbol')), 16],
      ['favicon.svg @32', dataUri(svgSource('symbol')), 32],
    ]
      .map(([l, u, s]) => `<span style="display:inline-flex;align-items:center;gap:6px"><img src="${u}" style="width:${s}px;height:${s}px" alt="">${l}</span>`)
      .join('') +
    '</div>';
  let body = '<div style="padding:10px;width:1100px">';
  body += `<h2>Splash art at imageWidth 220 on ${OFF_WHITE} (light) and ${NAVY} (dark), as expo-splash-screen shows it; favicons on light and dark tab strips.</h2>`;
  body += `<div class="row">${phone(light, OFF_WHITE, 360)}${phone(dark, NAVY, 360)}<div><img src="${light}" style="width:300px;background:${OFF_WHITE}" alt=""><div class="cap">splash-1200.png at 300 px</div><img src="${dark}" style="width:300px;background:${NAVY};margin-top:8px" alt=""><div class="cap">splash-dark-1200.png at 300 px</div></div></div>`;
  body += `<div class="row">${strip('#F1F3F4', '#333')}${strip('#202124', '#eee')}</div>`;
  body += `<div class="row"><div><img src="${pngUri(path.join(MOBILE, 'symbol-256.png'))}" style="width:128px;background:${OFF_WHITE}" alt=""><div class="cap">symbol-256.png at 128</div></div><div><img src="${pngUri(path.join(MOBILE, 'symbol-512.png'))}" style="width:128px;background:${NAVY}" alt=""><div class="cap">symbol-512.png on navy at 128</div></div></div>`;
  body += '</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${sheetStyle()}</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    '/tmp/claude-0/-home-user-claudecampsophie/b1b9c04d-3d1c-58be-b925-a948687d722a/scratchpad/demo/pw/node_modules',
  ].filter(Boolean);
  for (const dir of candidates) {
    for (const spec of [path.join(dir, 'playwright-core'), dir]) {
      try {
        return { module: require(spec), spec };
      } catch {
        // try the next candidate
      }
    }
  }
  try {
    return { module: require('playwright-core'), spec: 'playwright-core' };
  } catch {
    throw new Error(
      'playwright-core not found: set PLAYWRIGHT_CORE_PATH to a directory that contains it (do not run "playwright install").',
    );
  }
}

async function renderAll() {
  const { module: pw, spec } = resolvePlaywright();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (!existsSync(executablePath)) {
    throw new Error(`Chromium executable not found at ${executablePath}: set PLAYWRIGHT_CHROMIUM.`);
  }
  console.log(`playwright-core from ${spec}; chromium ${executablePath}`);
  const browser = await pw.chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const tab = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
    const shoot = async (html, width, height, transparent, file) => {
      await tab.setViewportSize({ width, height });
      await tab.setContent(html, { waitUntil: 'load' });
      await tab.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
      const png = await tab.screenshot({
        type: 'png',
        omitBackground: transparent,
        clip: { x: 0, y: 0, width, height },
      });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, png);
      console.log(`  wrote ${path.relative(root, file)} (${png.length} bytes)`);
    };
    for (const e of PNG_EXPORTS) await shoot(e.html(), e.width ?? e.size, e.height ?? e.size, !e.opaque, e.file);
    for (const c of SVG_COPIES) {
      mkdirSync(path.dirname(c.file), { recursive: true });
      writeFileSync(c.file, svgSource(c.from));
      console.log(`  wrote ${path.relative(root, c.file)}`);
    }
    writeFileSync(MANIFEST.file, `${JSON.stringify(MANIFEST.json, null, 2)}\n`);
    console.log(`  wrote ${path.relative(root, MANIFEST.file)}`);
    mkdirSync(REVIEW, { recursive: true });
    const sheets = [
      ['trace-vs-reference.png', traceSheet()],
      ['icon-masks.png', maskSheet()],
      ['splash-and-favicons.png', splashSheet()],
    ];
    for (const [name, html] of sheets) {
      await tab.setViewportSize({ width: 1120, height: 600 });
      await tab.setContent(html, { waitUntil: 'load' });
      await tab.evaluate(() => Promise.all(Array.from(document.images, (image) => image.decode())));
      const png = await tab.screenshot({ type: 'png', fullPage: true });
      writeFileSync(path.join(REVIEW, name), png);
      console.log(`  wrote ${path.relative(root, path.join(REVIEW, name))} (${png.length} bytes)`);
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Verification: a small PNG reader (8-bit RGB/RGBA, non-interlaced: what Chromium writes)
// ---------------------------------------------------------------------------------------------

function pngHeader(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlace: buffer[28],
  };
}

function decodePng(buffer) {
  const h = pngHeader(buffer);
  if (h.bitDepth !== 8 || h.interlace !== 0 || (h.colorType !== 2 && h.colorType !== 6)) {
    throw new Error(`unsupported PNG (bit depth ${h.bitDepth}, colour type ${h.colorType}, interlace ${h.interlace})`);
  }
  const channels = h.colorType === 6 ? 4 : 3;
  const idat = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = h.width * channels;
  const rgba = Buffer.alloc(h.width * h.height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < h.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter} on row ${y}`);
      line[i] = (line[i] + predictor) & 0xff;
    }
    for (let x = 0; x < h.width; x++) {
      const s = x * channels;
      const d = (y * h.width + x) * 4;
      rgba[d] = line[s];
      rgba[d + 1] = line[s + 1];
      rgba[d + 2] = line[s + 2];
      rgba[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    previous = line;
  }
  return { width: h.width, height: h.height, rgba };
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Largest distance from the centre (as a fraction of width) of any pixel that is not the ground. */
function contentRadius(image, ground) {
  const [gr, gg, gb] = ground ? hexToRgb(ground) : [0, 0, 0];
  const cx = (image.width - 1) / 2;
  const cy = (image.height - 1) / 2;
  let max = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const alpha = image.rgba[i + 3];
      let isContent;
      if (ground) {
        isContent =
          alpha > 0 &&
          Math.abs(image.rgba[i] - gr) + Math.abs(image.rgba[i + 1] - gg) + Math.abs(image.rgba[i + 2] - gb) > 24;
      } else isContent = alpha > 8;
      if (isContent) max = Math.max(max, Math.hypot(x - cx, y - cy));
    }
  }
  return max / image.width;
}

function verifyPng(e) {
  const problems = [];
  if (!existsSync(e.file)) return [`missing`];
  const buffer = readFileSync(e.file);
  const image = decodePng(buffer);
  const [ew, eh] = [e.width ?? e.size, e.height ?? e.size];
  if (image.width !== ew || image.height !== eh) problems.push(`is ${image.width}x${image.height}, expected ${ew}x${eh}`);
  const corners = [0, (image.width - 1) * 4, (image.height - 1) * image.width * 4, (image.width * image.height - 1) * 4];
  if (e.opaque) {
    let translucent = 0;
    for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] !== 255) translucent++;
    if (translucent) problems.push(`${translucent} non-opaque pixels in an opaque export`);
    const [r, g, b] = hexToRgb(e.ground);
    for (const c of corners) if (image.rgba[c] !== r || image.rgba[c + 1] !== g || image.rgba[c + 2] !== b) problems.push('corner is not the tile ground');
  } else {
    for (const c of corners) if (image.rgba[c + 3] !== 0) problems.push('corner is not transparent');
    let opaque = 0;
    for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] === 255) opaque++;
    if (opaque === 0) problems.push('no opaque pixels: nothing was drawn');
  }
  let radius = null;
  if (e.safe) {
    radius = contentRadius(image, e.opaque ? e.ground : null);
    if (radius > e.safe) problems.push(`content reaches ${(radius * 100).toFixed(1)} % of width from the centre; safe zone is ${(e.safe * 100).toFixed(1)} %`);
  }
  return { problems, bytes: buffer.length, radius };
}

function verifyAll() {
  let failed = false;
  let total = 0;
  const report = (file, ok, detail) => {
    console.log(`${ok ? '✓' : '✗'} ${path.relative(root, file)}${detail ? `: ${detail}` : ''}`);
    if (!ok) failed = true;
  };
  for (const e of PNG_EXPORTS) {
    const result = verifyPng(e);
    if (Array.isArray(result)) {
      report(e.file, false, result.join('; '));
      continue;
    }
    total += result.bytes;
    const extra = result.radius === null ? '' : `, content radius ${(result.radius * 100).toFixed(1)} % (limit ${(e.safe * 100).toFixed(1)} %)`;
    report(e.file, result.problems.length === 0, `${e.width ?? e.size}x${e.height ?? e.size}, ${e.opaque ? 'opaque' : 'transparent'}, ${result.bytes} bytes${extra}${result.problems.length ? '; ' + result.problems.join('; ') : ''}`);
  }
  for (const c of SVG_COPIES) {
    const ok = existsSync(c.file) && readFileSync(c.file, 'utf8') === svgSource(c.from);
    if (ok) total += readFileSync(c.file).length;
    report(c.file, ok, ok ? `identical to brand/assets/${c.from}.svg` : `missing or differs from brand/assets/${c.from}.svg`);
  }
  {
    let ok = existsSync(MANIFEST.file);
    let detail = 'missing';
    if (ok) {
      const parsed = JSON.parse(readFileSync(MANIFEST.file, 'utf8'));
      ok = parsed.name === 'PencilLift' && parsed.theme_color === TEAL && parsed.background_color === OFF_WHITE && parsed.icons.length === 4;
      detail = ok ? 'name, theme_color, background_color and icons as expected' : 'unexpected content';
      total += readFileSync(MANIFEST.file).length;
    }
    report(MANIFEST.file, ok, detail);
  }
  for (const name of REVIEW_SHEETS) {
    const file = path.join(REVIEW, name);
    const ok = existsSync(file);
    if (ok) {
      const bytes = readFileSync(file).length;
      total += bytes;
      const h = pngHeader(readFileSync(file));
      report(file, true, `${h.width}x${h.height}, ${bytes} bytes`);
    } else report(file, false, 'missing');
  }
  for (const name of ['symbol', 'symbol-on-teal', 'wordmark', 'tagline', 'lockup', 'lockup-no-tagline']) {
    const file = path.join(SOURCES, `${name}.svg`);
    const ok = existsSync(file) && readFileSync(file, 'utf8').includes('Traced from brand/approved_logo_reference.png');
    if (ok) total += readFileSync(file).length;
    report(file, ok, ok ? 'source with provenance header' : 'missing or without the provenance header');
  }
  const withinBudget = total <= SIZE_BUDGET_BYTES;
  report(path.join(root, 'brand/ASSETS.md'), withinBudget, `all listed files total ${(total / 1024).toFixed(0)} KB (budget ${SIZE_BUDGET_BYTES / 1024} KB)`);
  return !failed;
}

const check = process.argv.includes('--check');
if (!check) await renderAll();
const ok = verifyAll();
if (!ok) {
  console.error('brand asset verification failed');
  process.exit(1);
}

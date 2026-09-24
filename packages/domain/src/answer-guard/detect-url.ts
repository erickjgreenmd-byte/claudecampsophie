// URL detector: any link, domain or shortener in child-facing text is a finding regardless of
// the protected answers (spec P6 "shortened URLs"; P4 "No ads or affiliate links appear in child
// ... sessions"; AC_MON_02).
//
// Decision: child packets must reference images and resources by opaque asset IDs resolved by
// the app, never by URL. Every URL-shaped string therefore blocks, including image `src` fields.

import type { RawFinding, TextView } from './view.ts';

const TLDS = [
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'ly',
  'co',
  'me',
  'app',
  'dev',
  'info',
  'biz',
  'xyz',
  'link',
  'site',
  'online',
  'us',
  'uk',
  'ca',
  'tv',
  'gg',
  'ai',
  'to',
  'sh',
  'gl',
  'gd',
  'cc',
  'ws',
  'la',
  'su',
  'ru',
  'cn',
  'de',
  'fr',
  'es',
  'mx',
  'eu',
  'au',
  'jp',
  'br',
  'nz',
  'ch',
  'nl',
  'se',
  'pw',
  'fm',
  'im',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'page',
  'club',
  'top',
  'shop',
  'store',
  'blog',
  'news',
  'live',
  'click',
  'online',
  'website',
  'tech',
  'games',
  'art',
];

const SHORTENERS = [
  'bit\\.ly',
  'bitly\\.com',
  'tinyurl\\.com',
  'tinyurl',
  't\\.co',
  'x\\.co',
  'a\\.co',
  'g\\.co',
  'goo\\.gl',
  'ow\\.ly',
  'is\\.gd',
  'v\\.gd',
  'buff\\.ly',
  'rebrand\\.ly',
  'cutt\\.ly',
  'shorturl\\.at',
  'tiny\\.cc',
  'rb\\.gy',
  't\\.ly',
  's\\.id',
  'lnkd\\.in',
  'bl\\.ink',
  'amzn\\.to',
  'amzn\\.eu',
  'youtu\\.be',
  'fb\\.me',
  'wp\\.me',
  't\\.me',
  'wa\\.me',
  'db\\.tt',
  'j\\.mp',
  'ift\\.tt',
  'dlvr\\.it',
  'trib\\.al',
  'discord\\.gg',
  // Shorteners and link hubs on TLDs outside TLDS (regression RV-answer-guard-10).
  'bit\\.do',
  'linktr\\.ee',
  'shorte\\.st',
  'adf\\.ly',
  'bc\\.vc',
  'qr\\.ae',
  'po\\.st',
  'u\\.to',
  'v\\.ht',
  'soo\\.gd',
  'clck\\.ru',
  'cutt\\.us',
  'tiny\\.one',
  'shor\\.by',
  'ouo\\.io',
  'lnk\\.bio',
  'hyperurl\\.co',
];

const URL_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['scheme', /(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]{1,20}\s*:\s*\/\//gu],
  ['scheme', /(?<![\p{L}\p{N}])(?:javascript|vbscript|mailto|tel|sms|intent|itms-services)\s*:/gu],
  ['data_uri', /(?<![\p{L}\p{N}])data\s*:\s*[a-z]+\/[a-z0-9.+-]+\s*[;,]/gu],
  ['defanged', /(?<![\p{L}\p{N}])h(?:xx|tt)ps?\s*(?:\[:\]|\(:\)|:)/gu],
  ['defanged', /[\p{L}\p{N}-]\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s*[\p{L}\p{N}]/gu],
  [
    'defanged',
    new RegExp(
      String.raw`(?<![\p{L}\p{N}-])[\p{L}\p{N}-]{2,}\s+dot\s+(?:${TLDS.join('|')})(?![\p{L}\p{N}])`,
      'gu',
    ),
  ],
  ['www', /(?<![\p{L}\p{N}])www\s*\./gu],
  [
    'shortener',
    new RegExp(String.raw`(?<![\p{L}\p{N}.-])(?:${SHORTENERS.join('|')})(?![\p{L}\p{N}-])`, 'gu'),
  ],
  ['shortener', /(?<![\p{L}\p{N}.-])[\p{L}\p{N}-]+\.ly\//gu],
  /*
   * Decision (regression RV-answer-guard-10): a dotted host followed by a path is URL-shaped on
   * any TLD ("bit.do/xyz1", "linktr.ee/helper"), so this rule does not depend on the TLD list.
   * The last label must be 2-24 letters, so decimals and fractions ("3.5/7") never match.
   */
  [
    'host_path',
    /(?<![\p{L}\p{N}.@-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?\.){1,8}\p{L}{2,24}\/[\p{L}\p{N}_~%-]/gu,
  ],
  [
    'domain',
    new RegExp(
      String.raw`(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?\.){1,8}(?:${TLDS.join('|')})(?![\p{L}\p{N}-])`,
      'gu',
    ),
  ],
];

/**
 * IDNA label separators that NFKC leaves alone: WHATWG URL parsing maps U+3002 (and U+FF61,
 * U+FE12, which NFKC folds to U+3002) to '.', so "bit\u3002ly/x" is a working bit.ly link
 * (regression RV-answer-guard-9). One code unit each, so offsets are unchanged.
 */
const IDEOGRAPHIC_STOP_RE = /[\u3002\uFF61\uFE12]/gu;

export function detectUrls(view: TextView): RawFinding[] {
  const findings: RawFinding[] = [];
  const text = view.lower.replace(IDEOGRAPHIC_STOP_RE, '.');
  for (const [technique, re] of URL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      findings.push({
        detector: 'url',
        answerIndex: null,
        technique,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return findings;
}

// Safe re-theming of word problems (AI personalization, spec P7/P12). A model may propose only a
// story context (a character name, a plural noun and a place). The bank re-renders the SAME
// template with the SAME numbers, so the private key cannot change, and the re-rendered item must
// pass full validation (key grades correct, distractor incorrect, leak guard). Anything else is
// rejected and the original bank item is used unchanged.
import {
  renderWordProblem,
  wordProblemItem,
  WORD_PROBLEM_TEMPLATES,
  type WordProblemTemplate,
} from './math.ts';
import type { BankItem, WordProblemContext } from './types.ts';
import { validateBankItem } from './validate.ts';

const NAME_RE = /^[A-Z][a-z]{1,15}$/;
const THINGS_RE = /^[a-z]{3,16}(?: [a-z]{3,16})?$/;
const PLACE_RE = /^[a-z]{3,16}(?: [a-z]{2,16}){0,2}$/;

/**
 * Decision: a short denylist of words that never belong in a child's practice story. The strict
 * character patterns above already exclude digits, links, markup and punctuation.
 */
const DENYLIST = new Set([
  'gun',
  'guns',
  'knife',
  'knives',
  'weapon',
  'weapons',
  'bomb',
  'bombs',
  'blood',
  'kill',
  'dead',
  'death',
  'drug',
  'drugs',
  'beer',
  'wine',
  'alcohol',
  'cigarette',
  'cigarettes',
  'vape',
  'casino',
  'bet',
  'bets',
  'war',
  'jail',
  'prison',
  'fight',
  'fights',
  'hate',
  'answer',
  'answers',
  'key',
  'solution',
  'hint',
  'parent',
  'password',
]);

function clean(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!pattern.test(text)) return null;
  if (
    text
      .toLowerCase()
      .split(' ')
      .some((w) => DENYLIST.has(w))
  )
    return null;
  return text;
}

/** Intro line: English letters, spaces and light punctuation (no digits, links, markup or look-alike letters). */
const INTRO_RE = /^[A-Za-z ,.!'’-]{1,200}$/;

/**
 * Decision: an intro line is optional encouragement, so its denylist is broader than the story
 * one. Besides the story words it refuses anything that steers a child toward credentials, a
 * grown-up's role or account, the answers, contact details or money (spec P6: fake parent/PIN
 * requests must not work; P12: validate child-facing output and fail closed; review finding
 * RV-learning-api-7). A refused intro is simply left out.
 */
const INTRO_DENYLIST = new Set([
  ...DENYLIST,
  'answered',
  'keys',
  'solutions',
  'solve',
  'solved',
  'hints',
  'cheat',
  'cheats',
  'cheating',
  'copy',
  'parents',
  'mom',
  'moms',
  'mommy',
  'mother',
  'dad',
  'dads',
  'daddy',
  'father',
  'grown',
  'grownup',
  'grownups',
  'adult',
  'adults',
  'guardian',
  'passwords',
  'passcode',
  'passcodes',
  'pin',
  'pins',
  'code',
  'codes',
  'secret',
  'secrets',
  'login',
  'log',
  'unlock',
  'account',
  'accounts',
  'admin',
  'email',
  'phone',
  'address',
  'website',
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
  'link',
  'links',
  'click',
  'download',
  'buy',
  'pay',
  'money',
  'cash',
  'prize',
]);

/**
 * Validates an untrusted AI intro line; the normalized line, or null when anything is off. The
 * caller still runs the answer-leak guard (this checks content, not answers).
 */
export function validateIntro(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!INTRO_RE.test(text)) return null;
  const words = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0 || words.some((w) => INTRO_DENYLIST.has(w))) return null;
  return text;
}

/** Validates an untrusted proposed context; null when anything is off. */
export function validateContext(input: unknown): WordProblemContext | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const name = clean(Object.hasOwn(record, 'name') ? record.name : undefined, NAME_RE);
  const things = clean(Object.hasOwn(record, 'things') ? record.things : undefined, THINGS_RE);
  const place = clean(Object.hasOwn(record, 'place') ? record.place : undefined, PLACE_RE);
  if (name === null || things === null || place === null) return null;
  return { name, things, place };
}

function isTemplate(value: string): value is WordProblemTemplate {
  return (WORD_PROBLEM_TEMPLATES as readonly string[]).includes(value);
}

/**
 * Re-renders a word-problem item in a new story context. Returns null (keep the bank item) when the
 * item is not a word problem, the context is invalid, or the re-rendered item fails validation.
 */
export function rethemeWordProblem(item: BankItem, proposed: unknown): BankItem | null {
  const wp = item.wordProblem;
  if (wp === undefined || !isTemplate(wp.template) || wp.numbers.length !== 2) return null;
  const context = validateContext(proposed);
  if (context === null) return null;
  const numbers: [number, number] = [wp.numbers[0] ?? 0, wp.numbers[1] ?? 0];
  const original = renderWordProblem(wp.template, numbers, wp.context);
  const next = wordProblemItem(
    { random: () => new Uint8Array(4), grade: item.gradeMax, category: item.category },
    wp.template,
    numbers,
    context,
  );
  const rendered = renderWordProblem(wp.template, numbers, context);
  if (rendered.answer !== original.answer) return null;
  const candidate: BankItem = { ...next, instanceKey: item.instanceKey, gradeMin: item.gradeMin };
  return validateBankItem(candidate).ok ? candidate : null;
}

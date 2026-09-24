// Parameterized, original math generators (spec P7 "parameterized math"). Every draw is validated
// by the caller; a draw whose prompt would reveal its own answer (e.g. "14 - 7") is discarded.
import type { RandomSource } from '../shared/random.ts';
import {
  buildItem,
  choices,
  fmt,
  fraction,
  gcd,
  numericSpec,
  prompt,
  reducedFraction,
} from './build.ts';
import { pick, randInt } from './random.ts';
import type { BankCategory, BankItem, WordProblemContext } from './types.ts';

export interface GenContext {
  readonly random: RandomSource;
  /** Child grade 0..8 (already clamped). */
  readonly grade: number;
  readonly category: BankCategory;
}

type MathGenerator = (ctx: GenContext) => BankItem;

const easy = (ctx: GenContext): boolean => ctx.category === 'accessible';

// ------------------------------------------------------------------------------------------------

const addSubWithin20: MathGenerator = (ctx) => {
  const { random } = ctx;
  const limit = easy(ctx) || ctx.grade === 0 ? 10 : 20;
  const add = randInt(random, 0, 1) === 0;
  if (add) {
    const a = randInt(random, 1, limit - 1);
    const b = randInt(random, 1, limit - a);
    return buildItem({
      templateKey: 'math.add_within_20.v1',
      subject: 'math',
      skill: 'math.add_sub_within_20',
      gradeMin: 0,
      gradeMax: 2,
      category: ctx.category,
      prompt: prompt(`What is ${a} + ${b}?`, 'number'),
      answerSpec: numericSpec(a + b),
      explanation: `Count on from ${a} by ${b}: ${a} + ${b} = ${a + b}.`,
      distractor: String(a + b + 1),
      params: { a, b },
    });
  }
  const a = randInt(random, 3, limit);
  const b = randInt(random, 1, a - 1);
  return buildItem({
    templateKey: 'math.sub_within_20.v1',
    subject: 'math',
    skill: 'math.add_sub_within_20',
    gradeMin: 0,
    gradeMax: 2,
    category: ctx.category,
    prompt: prompt(`What is ${a} − ${b}?`, 'number'),
    answerSpec: numericSpec(a - b),
    explanation: `Think addition: ${b} + ? = ${a}, so ${a} − ${b} = ${a - b}.`,
    distractor: String(a - b + 1),
    params: { a, b, op: '-' },
  });
};

const PLACE_NAMES = ['ones', 'tens', 'hundreds', 'thousands', 'ten thousands'] as const;

function distinctDigitNumber(random: RandomSource, digits: number): number {
  const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  let n = 0;
  for (let i = 0; i < digits; i += 1) {
    const index = randInt(random, 0, pool.length - 1);
    const [d] = pool.splice(index, 1);
    n = n * 10 + (d ?? 1);
  }
  return n;
}

const placeValue: MathGenerator = (ctx) => {
  const { random } = ctx;
  const digits = easy(ctx) || ctx.grade <= 2 ? 3 : ctx.grade === 3 ? 4 : 5;
  const n = distinctDigitNumber(random, digits);
  const position = randInt(random, 1, digits - 1); // never the ones place (its value is the digit)
  const digit = Math.floor(n / 10 ** position) % 10;
  const value = digit * 10 ** position;
  const place = PLACE_NAMES[position] ?? 'tens';
  if (randInt(random, 0, 1) === 0) {
    return buildItem({
      templateKey: 'math.place_value.value_of_digit.v1',
      subject: 'math',
      skill: 'math.place_value',
      gradeMin: 1,
      gradeMax: 4,
      category: ctx.category,
      prompt: prompt(`What is the value of the digit ${digit} in the number ${fmt(n)}?`, 'number'),
      answerSpec: numericSpec(value),
      explanation: `In ${fmt(n)} the digit ${digit} is in the ${place} place, so its value is ${digit} × ${fmt(10 ** position)} = ${fmt(value)}.`,
      distractor: String(digit === 9 ? value / 10 : value * 10),
      params: { n, position, ask: 'value' },
    });
  }
  return buildItem({
    templateKey: 'math.place_value.digit_in_place.v1',
    subject: 'math',
    skill: 'math.place_value',
    gradeMin: 1,
    gradeMax: 4,
    category: ctx.category,
    prompt: prompt(`Which digit is in the ${place} place in the number ${fmt(n)}?`, 'number'),
    answerSpec: numericSpec(digit),
    explanation: `Reading ${fmt(n)} from the right: ones, tens, hundreds, ... The ${place} digit is ${digit}.`,
    distractor: String(digit === 9 ? 8 : digit + 1),
    params: { n, position, ask: 'digit' },
  });
};

const additionRegrouping: MathGenerator = (ctx) => {
  const { random } = ctx;
  const big = !easy(ctx) && ctx.grade >= 3;
  let a: number;
  let b: number;
  do {
    a = big ? randInt(random, 105, 899) : randInt(random, 15, 89);
    b = big ? randInt(random, 105, 899) : randInt(random, 6, 89);
  } while ((a % 10) + (b % 10) < 10 || (big && a + b > 999));
  const sum = a + b;
  return buildItem({
    templateKey: 'math.addition_regrouping.v1',
    subject: 'math',
    skill: 'math.addition_regrouping',
    gradeMin: 2,
    gradeMax: 4,
    category: ctx.category,
    prompt: prompt(`Add: ${a} + ${b}`, 'number'),
    answerSpec: numericSpec(sum),
    explanation: `Line up the places. Ones: ${a % 10} + ${b % 10} = ${(a % 10) + (b % 10)}, so write ${((a % 10) + (b % 10)) % 10} and regroup 1 ten. Continue with the tens (and hundreds) to get ${sum}.`,
    // The classic slip: forgetting the regrouped ten.
    distractor: String(sum - 10),
    params: { a, b },
  });
};

const subtractionRegrouping: MathGenerator = (ctx) => {
  const { random } = ctx;
  const big = !easy(ctx) && ctx.grade >= 3;
  let a: number;
  let b: number;
  do {
    a = big ? randInt(random, 302, 999) : randInt(random, 31, 99);
    b = big ? randInt(random, 105, a - 10) : randInt(random, 12, a - 5);
  } while (a % 10 >= b % 10 || b >= a);
  const diff = a - b;
  // Subtracting the smaller ones digit from the larger one instead of regrouping.
  const slip = Math.floor(a / 10) * 10 - Math.floor(b / 10) * 10 + ((b % 10) - (a % 10));
  return buildItem({
    templateKey: 'math.subtraction_regrouping.v1',
    subject: 'math',
    skill: 'math.subtraction_regrouping',
    gradeMin: 2,
    gradeMax: 4,
    category: ctx.category,
    prompt: prompt(`Subtract: ${a} − ${b}`, 'number'),
    answerSpec: numericSpec(diff),
    explanation: `The ones digit ${a % 10} is smaller than ${b % 10}, so regroup 1 ten as 10 ones: ${(a % 10) + 10} − ${b % 10} = ${(a % 10) + 10 - (b % 10)}. Then subtract the remaining places to get ${diff}.`,
    distractor: String(slip === diff ? diff + 10 : slip),
    params: { a, b },
  });
};

const multiplicationFacts: MathGenerator = (ctx) => {
  const { random } = ctx;
  const max = easy(ctx) ? 5 : 12;
  const a = randInt(random, 2, max);
  const b = randInt(random, 2, max);
  return buildItem({
    templateKey: 'math.multiplication_facts.v1',
    subject: 'math',
    skill: 'math.multiplication_facts',
    gradeMin: 3,
    gradeMax: 5,
    category: ctx.category,
    prompt: prompt(`What is ${a} × ${b}?`, 'number'),
    answerSpec: numericSpec(a * b),
    explanation: `${a} × ${b} means ${a} groups of ${b}: ${a * b}.`,
    distractor: String(a * b + a),
    params: { a, b },
  });
};

const divisionRemainders: MathGenerator = (ctx) => {
  const { random } = ctx;
  const divisor = randInt(random, 2, easy(ctx) ? 5 : 9);
  const quotient = randInt(random, 2, easy(ctx) ? 9 : 12);
  const remainder = randInt(random, 1, divisor - 1);
  const dividend = divisor * quotient + remainder;
  return buildItem({
    templateKey: 'math.division_remainders.v1',
    subject: 'math',
    skill: 'math.division_remainders',
    gradeMin: 3,
    gradeMax: 6,
    category: ctx.category,
    prompt: prompt(
      `Divide ${dividend} by ${divisor}. Write the quotient, then R, then the remainder.`,
      'division',
    ),
    answerSpec: {
      kind: 'division_remainder',
      quotient,
      remainder,
      divisor,
      alternates: [],
    },
    explanation: `${divisor} × ${quotient} = ${divisor * quotient}, and ${dividend} − ${divisor * quotient} = ${remainder}, which is less than ${divisor}. So ${dividend} ÷ ${divisor} = ${quotient} R ${remainder}.`,
    distractor: `${quotient + 1} R ${remainder}`,
    params: { dividend, divisor },
  });
};

const DENOMINATORS = [2, 3, 4, 5, 6, 8, 10, 12] as const;

const fractionsCompare: MathGenerator = (ctx) => {
  const { random } = ctx;
  const mode = easy(ctx) ? 'same_den' : pick(random, ['same_den', 'same_num', 'unlike'] as const);
  let a: [number, number];
  let b: [number, number];
  do {
    if (mode === 'same_den') {
      const d = pick(random, DENOMINATORS);
      a = [randInt(random, 1, d - 1), d];
      b = [randInt(random, 1, d - 1), d];
    } else if (mode === 'same_num') {
      const n = randInt(random, 1, 5);
      a = [n, pick(random, DENOMINATORS)];
      b = [n, pick(random, DENOMINATORS)];
    } else {
      a = [0, pick(random, DENOMINATORS)];
      b = [0, pick(random, DENOMINATORS)];
      a[0] = randInt(random, 1, a[1] - 1);
      b[0] = randInt(random, 1, b[1] - 1);
    }
  } while (a[0] >= a[1] || b[0] >= b[1] || a[0] * b[1] === b[0] * a[1]);
  const aText = fraction(a[0], a[1]);
  const bText = fraction(b[0], b[1]);
  const aBigger = a[0] * b[1] > b[0] * a[1];
  if (randInt(random, 0, 1) === 0) {
    const setup = choices(random, aBigger ? aText : bText, [aBigger ? bText : aText]);
    return buildItem({
      templateKey: 'math.fractions_compare.greater.v1',
      subject: 'math',
      skill: 'math.fractions_compare',
      gradeMin: 3,
      gradeMax: 5,
      category: ctx.category,
      prompt: prompt('Which fraction is greater?', 'choice', { choices: setup.choices }),
      answerSpec: setup.spec,
      explanation: `Compare ${aText} and ${bText} with a common denominator (${a[0] * b[1]}/${a[1] * b[1]} and ${b[0] * a[1]}/${a[1] * b[1]}); ${aBigger ? aText : bText} is greater.`,
      distractor: setup.wrongLetter,
      params: { a, b, ask: 'greater' },
    });
  }
  const symbol = aBigger ? '>' : '<';
  const setup = choices(
    random,
    symbol,
    ['<', '=', '>'].filter((s) => s !== symbol),
    ['<', '=', '>'],
  );
  return buildItem({
    templateKey: 'math.fractions_compare.symbol.v1',
    subject: 'math',
    skill: 'math.fractions_compare',
    gradeMin: 3,
    gradeMax: 5,
    category: ctx.category,
    prompt: prompt(`Which symbol makes this true?   ${aText}  ?  ${bText}`, 'choice', {
      choices: setup.choices,
    }),
    answerSpec: setup.spec,
    explanation: `Rewrite with a common denominator: ${a[0] * b[1]}/${a[1] * b[1]} and ${b[0] * a[1]}/${a[1] * b[1]}, so ${aText} ${symbol} ${bText}.`,
    distractor: setup.wrongLetter,
    params: { a, b, ask: 'symbol' },
  });
};

const fractionsAddLike: MathGenerator = (ctx) => {
  const { random } = ctx;
  const d = pick(random, easy(ctx) ? ([4, 5, 6, 8] as const) : ([3, 4, 5, 6, 8, 10, 12] as const));
  const allowImproper = !easy(ctx) && ctx.grade >= 5;
  let x: number;
  let y: number;
  do {
    // A sum equal to one whole (e.g. 2/4 + 2/4) is left out: it is a different skill.
    x = randInt(random, 1, d - 1);
    y = randInt(random, 1, d - 1);
  } while (x + y === d || (!allowImproper && x + y > d));
  const sum = x + y;
  return buildItem({
    templateKey: 'math.fractions_add_like.v1',
    subject: 'math',
    skill: 'math.fractions_add_like',
    gradeMin: 3,
    gradeMax: 5,
    category: ctx.category,
    prompt: prompt(`Add: ${fraction(x, d)} + ${fraction(y, d)}`, 'text'),
    answerSpec: numericSpec(fraction(sum, d)),
    explanation: `The denominators match, so add the numerators: ${x} + ${y} = ${sum}. The sum is ${fraction(sum, d)}${reducedFraction(sum, d) === fraction(sum, d) ? '' : ` = ${reducedFraction(sum, d)}`}.`,
    // Adding the denominators too is the classic misconception.
    distractor: fraction(sum, d + d),
    params: { x, y, d },
  });
};

const UNLIKE_PAIRS: readonly (readonly [number, number])[] = [
  [2, 4],
  [3, 6],
  [2, 3],
  [3, 4],
  [4, 8],
  [2, 5],
  [5, 10],
  [3, 9],
  [4, 6],
  [2, 6],
  [6, 12],
];

const fractionsAddUnlike: MathGenerator = (ctx) => {
  const { random } = ctx;
  const [d1, d2] = pick(random, easy(ctx) ? UNLIKE_PAIRS.slice(0, 5) : UNLIKE_PAIRS);
  const x = randInt(random, 1, d1 - 1);
  const y = randInt(random, 1, d2 - 1);
  const lcd = (d1 * d2) / gcd(d1, d2);
  const num = x * (lcd / d1) + y * (lcd / d2);
  return buildItem({
    templateKey: 'math.fractions_add_unlike.v1',
    subject: 'math',
    skill: 'math.fractions_add_unlike',
    gradeMin: 4,
    gradeMax: 7,
    category: ctx.category,
    prompt: prompt(`Add: ${fraction(x, d1)} + ${fraction(y, d2)}`, 'text'),
    answerSpec: numericSpec(reducedFraction(num, lcd)),
    explanation: `Use the common denominator ${lcd}: ${fraction(x * (lcd / d1), lcd)} + ${fraction(y * (lcd / d2), lcd)} = ${fraction(num, lcd)}${reducedFraction(num, lcd) === fraction(num, lcd) ? '' : ` = ${reducedFraction(num, lcd)}`}.`,
    distractor: fraction(x + y, d1 + d2),
    params: { x, d1, y, d2 },
  });
};

function decimalText(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const frac = hundredths % 100;
  if (frac === 0) return String(whole);
  return frac % 10 === 0 ? `${whole}.${frac / 10}` : `${whole}.${String(frac).padStart(2, '0')}`;
}

const decimals: MathGenerator = (ctx) => {
  const { random } = ctx;
  if (randInt(random, 0, 1) === 0) {
    const a = randInt(random, 1, 9) * 10; // tenths
    const b = easy(ctx) ? randInt(random, 1, 9) * 10 : randInt(random, 11, 99);
    return buildItem({
      templateKey: 'math.decimals.add.v1',
      subject: 'math',
      skill: 'math.decimals',
      gradeMin: 4,
      gradeMax: 7,
      category: ctx.category,
      prompt: prompt(`Add: ${decimalText(a)} + ${decimalText(b)}`, 'number'),
      answerSpec: numericSpec(decimalText(a + b)),
      explanation: `Line up the decimal points (write ${decimalText(a)} as ${(a / 100).toFixed(2)}) and add hundredths, then tenths: ${decimalText(a + b)}.`,
      distractor:
        decimalText(a / 10 + b) === decimalText(a + b)
          ? decimalText(a + b + 1)
          : decimalText(a / 10 + b),
      params: { a, b, op: 'add' },
    });
  }
  // Compare: a tenths value against a hundredths value with more digits (the "longer is larger" trap).
  let t: number;
  let h: number;
  do {
    t = randInt(random, 1, 9) * 10;
    h = randInt(random, 11, 99);
  } while (h % 10 === 0 || t === h);
  const bigger = t > h ? decimalText(t) : decimalText(h);
  const smaller = t > h ? decimalText(h) : decimalText(t);
  const setup = choices(random, bigger, [smaller]);
  return buildItem({
    templateKey: 'math.decimals.compare.v1',
    subject: 'math',
    skill: 'math.decimals',
    gradeMin: 4,
    gradeMax: 7,
    category: ctx.category,
    prompt: prompt('Which number is greater?', 'choice', { choices: setup.choices }),
    answerSpec: setup.spec,
    explanation: `Compare place by place: ${decimalText(t)} = ${(t / 100).toFixed(2)}, so ${bigger} is greater than ${smaller}.`,
    distractor: setup.wrongLetter,
    params: { t, h, op: 'compare' },
  });
};

const CONVERSIONS = [
  { from: 'meters', to: 'centimeters', unit: 'cm', factor: 100, minGrade: 3 },
  { from: 'centimeters', to: 'millimeters', unit: 'mm', factor: 10, minGrade: 3 },
  { from: 'kilometers', to: 'meters', unit: 'm', factor: 1000, minGrade: 4 },
  { from: 'kilograms', to: 'grams', unit: 'g', factor: 1000, minGrade: 4 },
  { from: 'liters', to: 'milliliters', unit: 'mL', factor: 1000, minGrade: 4 },
  { from: 'feet', to: 'inches', unit: 'in', factor: 12, minGrade: 4 },
  { from: 'yards', to: 'feet', unit: 'ft', factor: 3, minGrade: 3 },
  { from: 'hours', to: 'minutes', unit: 'min', factor: 60, minGrade: 3 },
  { from: 'minutes', to: 'seconds', unit: 's', factor: 60, minGrade: 4 },
] as const;

const measurementConversion: MathGenerator = (ctx) => {
  const { random } = ctx;
  const pool = CONVERSIONS.filter((c) => c.minGrade <= Math.max(3, ctx.grade));
  const c = pick(random, easy(ctx) ? pool.filter((p) => p.factor <= 100) : pool);
  const n = randInt(random, 2, easy(ctx) ? 5 : 9);
  const answer = n * c.factor;
  return buildItem({
    templateKey: 'math.measurement_conversion.v1',
    subject: 'math',
    skill: 'math.measurement_conversion',
    gradeMin: 3,
    gradeMax: 7,
    category: ctx.category,
    prompt: prompt(`How many ${c.to} are in ${n} ${c.from}?`, 'number', { unitHint: c.unit }),
    answerSpec: numericSpec(answer, c.unit),
    explanation: `There are ${c.factor} ${c.to} in one of the larger unit, so multiply: ${n} × ${c.factor} = ${answer} ${c.to}.`,
    distractor: String(answer + c.factor),
    params: { from: c.from, n },
  });
};

/** Original story contexts; the AI may propose others that pass the same checks. */
export const DEFAULT_CONTEXTS: readonly WordProblemContext[] = [
  { name: 'Maya', things: 'seashells', place: 'beach' },
  { name: 'Leo', things: 'stickers', place: 'library' },
  { name: 'Ana', things: 'apples', place: 'orchard' },
  { name: 'Omar', things: 'marbles', place: 'park' },
  { name: 'Kai', things: 'pinecones', place: 'forest trail' },
  { name: 'Zoe', things: 'beads', place: 'art room' },
  { name: 'Ben', things: 'baseball cards', place: 'yard sale' },
  { name: 'Lila', things: 'tomatoes', place: 'garden' },
  { name: 'Theo', things: 'paper cranes', place: 'craft fair' },
  { name: 'Ivy', things: 'acorns', place: 'playground' },
];

export const WORD_PROBLEM_TEMPLATES = ['join', 'separate', 'compare', 'array', 'share'] as const;
export type WordProblemTemplate = (typeof WORD_PROBLEM_TEMPLATES)[number];

/** Renders a word problem; the numbers (and so the answer) never depend on the context. */
export function renderWordProblem(
  template: WordProblemTemplate,
  numbers: readonly [number, number],
  context: WordProblemContext,
): { text: string; answer: number; explanation: string; slip: number } {
  const [a, b] = numbers;
  const { name, things, place } = context;
  switch (template) {
    case 'join':
      return {
        text: `${name} found ${a} ${things} at the ${place}. Later, ${name} found ${b} more. How many ${things} did ${name} find in all?`,
        answer: a + b,
        explanation: `"In all" means join the two groups: ${a} + ${b} = ${a + b}.`,
        slip: a - b,
      };
    case 'separate':
      return {
        text: `${name} had ${a} ${things} at the ${place} and gave ${b} of them to a friend. How many ${things} does ${name} have left?`,
        answer: a - b,
        explanation: `Giving some away means take them out: ${a} − ${b} = ${a - b}.`,
        slip: a + b,
      };
    case 'compare':
      return {
        text: `At the ${place}, ${name} collected ${a} ${things}. A friend collected ${b} ${things}. How many more ${things} did ${name} collect than the friend?`,
        answer: a - b,
        explanation: `"How many more" compares the two amounts: ${a} − ${b} = ${a - b}.`,
        slip: a + b,
      };
    case 'array':
      return {
        text: `At the ${place}, ${name} set out ${a} rows of ${things} with ${b} in each row. How many ${things} did ${name} set out?`,
        answer: a * b,
        explanation: `Equal rows make a multiplication: ${a} × ${b} = ${a * b}.`,
        slip: a + b,
      };
    case 'share':
      return {
        text: `${name} shared ${a} ${things} equally among ${b} friends at the ${place}. How many ${things} did each friend get?`,
        answer: a / b,
        explanation: `Sharing equally is division: ${a} ÷ ${b} = ${a / b}.`,
        slip: a - b,
      };
  }
}

function wordProblemNumbers(
  random: RandomSource,
  template: WordProblemTemplate,
  grade: number,
  accessible: boolean,
): [number, number] {
  const max = accessible || grade <= 2 ? 20 : grade <= 3 ? 100 : 500;
  switch (template) {
    case 'join': {
      const a = randInt(random, 2, max - 2);
      return [a, randInt(random, 1, Math.max(1, max - a))];
    }
    case 'separate':
    case 'compare': {
      const a = randInt(random, 5, max);
      return [a, randInt(random, 1, a - 2)];
    }
    case 'array':
      return [randInt(random, 2, accessible ? 5 : 9), randInt(random, 2, accessible ? 5 : 9)];
    case 'share': {
      const b = randInt(random, 2, accessible ? 5 : 9);
      return [b * randInt(random, 2, accessible ? 5 : 9), b];
    }
  }
}

export function wordProblemItem(
  ctx: GenContext,
  template: WordProblemTemplate,
  numbers: readonly [number, number],
  context: WordProblemContext,
): BankItem {
  const r = renderWordProblem(template, numbers, context);
  return buildItem({
    templateKey: `math.word_problems.${template}.v1`,
    subject: 'math',
    skill: 'math.word_problems',
    gradeMin: template === 'array' || template === 'share' ? 3 : 1,
    gradeMax: 6,
    category: ctx.category,
    prompt: prompt(r.text, 'number'),
    answerSpec: numericSpec(r.answer),
    explanation: r.explanation,
    distractor: String(r.slip === r.answer ? r.answer + 1 : r.slip),
    params: { template, numbers },
    wordProblem: { template, numbers: [...numbers], context },
  });
}

const wordProblems: MathGenerator = (ctx) => {
  const { random } = ctx;
  const templates: WordProblemTemplate[] =
    ctx.grade >= 3 && !easy(ctx)
      ? ['join', 'separate', 'compare', 'array', 'share']
      : ['join', 'separate', 'compare'];
  const template = pick(random, templates);
  const numbers = wordProblemNumbers(random, template, ctx.grade, easy(ctx));
  return wordProblemItem(ctx, template, numbers, pick(random, DEFAULT_CONTEXTS));
};

const areaPerimeter: MathGenerator = (ctx) => {
  const { random } = ctx;
  let l: number;
  let w: number;
  do {
    l = randInt(random, 3, easy(ctx) ? 6 : 12);
    w = randInt(random, 2, easy(ctx) ? 5 : 9);
  } while (l === w || l * w === 2 * (l + w));
  const area = randInt(random, 0, 1) === 0;
  const answer = area ? l * w : 2 * (l + w);
  return buildItem({
    templateKey: area ? 'math.area_perimeter.area.v1' : 'math.area_perimeter.perimeter.v1',
    subject: 'math',
    skill: 'math.area_perimeter',
    gradeMin: 3,
    gradeMax: 6,
    category: ctx.category,
    prompt: prompt(
      area
        ? `A rectangle is ${l} units long and ${w} units wide. What is its area in square units?`
        : `A rectangle is ${l} units long and ${w} units wide. What is its perimeter in units?`,
      'number',
    ),
    answerSpec: numericSpec(answer),
    explanation: area
      ? `Area = length × width = ${l} × ${w} = ${answer} square units.`
      : `Perimeter adds all four sides: ${l} + ${w} + ${l} + ${w} = ${answer} units.`,
    // Mixing up area and perimeter is the common slip.
    distractor: String(area ? 2 * (l + w) : l * w),
    params: { l, w, area },
  });
};

const oneStepEquations: MathGenerator = (ctx) => {
  const { random } = ctx;
  const kind = pick(random, ['add', 'sub', 'mul', 'div'] as const);
  const x = randInt(random, 2, easy(ctx) ? 12 : 30);
  const a = randInt(random, 2, easy(ctx) ? 9 : 15);
  const [text, explanation] =
    kind === 'add'
      ? [
          `Solve for x:  x + ${a} = ${x + a}`,
          `Subtract ${a} from both sides: x = ${x + a} − ${a} = ${x}.`,
        ]
      : kind === 'sub'
        ? [
            `Solve for x:  x − ${a} = ${x - a}`,
            `Add ${a} to both sides: x = ${x - a} + ${a} = ${x}.`,
          ]
        : kind === 'mul'
          ? [
              `Solve for x:  ${a}x = ${a * x}`,
              `Divide both sides by ${a}: x = ${a * x} ÷ ${a} = ${x}.`,
            ]
          : [
              `Solve for x:  x ÷ ${a} = ${x}`,
              `Multiply both sides by ${a}: x = ${x} × ${a} = ${x * a}.`,
            ];
  const answer = kind === 'div' ? x * a : x;
  return buildItem({
    templateKey: `math.one_step_equations.${kind}.v1`,
    subject: 'math',
    skill: 'math.one_step_equations',
    gradeMin: 6,
    gradeMax: 8,
    category: ctx.category,
    prompt: prompt(text, 'number'),
    answerSpec: numericSpec(answer),
    explanation,
    distractor: String(answer + a),
    params: { kind, x, a },
  });
};

const PERCENTS = [10, 20, 25, 50, 75] as const;

const percentOf: MathGenerator = (ctx) => {
  const { random } = ctx;
  const p = pick(random, easy(ctx) ? ([10, 50] as const) : PERCENTS);
  const step = p === 25 || p === 75 ? 4 : p === 20 ? 5 : p === 50 ? 2 : 10;
  const n = step * randInt(random, 2, easy(ctx) ? 10 : 30);
  const answer = (p * n) / 100;
  return buildItem({
    templateKey: 'math.percent_of.v1',
    subject: 'math',
    skill: 'math.percent_of',
    gradeMin: 6,
    gradeMax: 8,
    category: ctx.category,
    prompt: prompt(`What is ${p}% of ${n}?`, 'number'),
    answerSpec: numericSpec(answer),
    explanation: `${p}% means ${p} per 100, so ${p}% of ${n} = ${p}/100 × ${n} = ${answer}.`,
    distractor: String(answer + step),
    params: { p, n },
  });
};

export const MATH_GENERATORS: Readonly<Record<string, MathGenerator>> = {
  'math.add_sub_within_20': addSubWithin20,
  'math.place_value': placeValue,
  'math.addition_regrouping': additionRegrouping,
  'math.subtraction_regrouping': subtractionRegrouping,
  'math.multiplication_facts': multiplicationFacts,
  'math.division_remainders': divisionRemainders,
  'math.fractions_compare': fractionsCompare,
  'math.fractions_add_like': fractionsAddLike,
  'math.fractions_add_unlike': fractionsAddUnlike,
  'math.decimals': decimals,
  'math.measurement_conversion': measurementConversion,
  'math.word_problems': wordProblems,
  'math.area_perimeter': areaPerimeter,
  'math.one_step_equations': oneStepEquations,
  'math.percent_of': percentOf,
};

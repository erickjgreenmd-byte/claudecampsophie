import { defaultDeviceLabel } from './pairing-code.ts';

/**
 * Child-safety guardrails for screens a child can reach without the parent PIN (Apple App Store
 * guideline 1.3 / 5.1.4, Google Play Families policy; audit items APL-02 / PLAY-07 and PLAY-05).
 *
 * The parental gate is Apple's documented pattern: a random multiplication a grown-up answers
 * before an outbound link opens ("Ask a grown-up: what is 7 × 8?"). Three misses lock the gate for
 * a short while so it cannot be guessed by tapping through. Pure: no react-native imports, no
 * clock (`now` is passed in, milliseconds since the epoch), randomness injected for tests. Nothing
 * here is stored or sent anywhere.
 */

export const GATE_FACTOR_MIN = 3;
export const GATE_FACTOR_MAX = 9;
export const GATE_MAX_MISSES = 3;
export const GATE_LOCKOUT_MS = 60_000;

export interface GateChallenge {
  readonly left: number;
  readonly right: number;
  readonly answer: number;
  readonly prompt: string;
}

export interface GateState {
  readonly challenge: GateChallenge;
  /** Wrong answers since the gate was opened or last passed. */
  readonly misses: number;
  /** Epoch milliseconds until which answers are refused, or null when open. */
  readonly lockedUntil: number | null;
}

export type GateOutcome =
  | { readonly kind: 'passed'; readonly state: GateState }
  | {
      readonly kind: 'wrong';
      readonly state: GateState;
      readonly message: string;
      /** False for an empty or non-numeric answer, which is not a guess. */
      readonly counted: boolean;
    }
  | {
      readonly kind: 'locked';
      readonly state: GateState;
      readonly message: string;
      readonly retryInSeconds: number;
    };

function factor(random: () => number): number {
  const span = GATE_FACTOR_MAX - GATE_FACTOR_MIN + 1;
  const r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return GATE_FACTOR_MIN + Math.floor(r * span);
}

/** A fresh multiplication with both factors in [GATE_FACTOR_MIN, GATE_FACTOR_MAX]. */
export function newChallenge(random: () => number = Math.random): GateChallenge {
  const left = factor(random);
  const right = factor(random);
  return {
    left,
    right,
    answer: left * right,
    prompt: `Ask a grown-up: what is ${left} × ${right}?`,
  };
}

export type GateLock =
  { readonly locked: true; readonly retryInSeconds: number } | { readonly locked: false };

export function gateLock(state: GateState, now: number): GateLock {
  if (state.lockedUntil === null || state.lockedUntil <= now) return { locked: false };
  return { locked: true, retryInSeconds: Math.max(1, Math.ceil((state.lockedUntil - now) / 1000)) };
}

function lockMessage(retryInSeconds: number): string {
  return `Too many tries. Please wait ${retryInSeconds} ${retryInSeconds === 1 ? 'second' : 'seconds'}, then ask a grown-up to try again.`;
}

/**
 * Opens the gate. A `previous` state (for example from a cancelled attempt) carries its lock over,
 * so closing and reopening the gate never resets the lockout; an expired lock starts over fresh.
 */
export function openGate(
  now: number,
  random: () => number = Math.random,
  previous: GateState | null = null,
): GateState {
  if (previous && gateLock(previous, now).locked) return previous;
  return { challenge: newChallenge(random), misses: 0, lockedUntil: null };
}

function parseAnswer(input: string): number | null {
  const trimmed = input.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/** Checks a typed answer. The answer is never echoed in a message. */
export function answerGate(
  state: GateState,
  input: string,
  now: number,
  random: () => number = Math.random,
): GateOutcome {
  const lock = gateLock(state, now);
  if (lock.locked) {
    return {
      kind: 'locked',
      state,
      message: lockMessage(lock.retryInSeconds),
      retryInSeconds: lock.retryInSeconds,
    };
  }
  const answer = parseAnswer(input);
  if (answer === null) {
    return {
      kind: 'wrong',
      state,
      message: 'Type the answer as a number, then tap Check.',
      counted: false,
    };
  }
  if (answer === state.challenge.answer) {
    return { kind: 'passed', state: { ...state, misses: 0, lockedUntil: null } };
  }
  const misses = state.misses + 1;
  const challenge = newChallenge(random);
  if (misses >= GATE_MAX_MISSES) {
    const lockedUntil = now + GATE_LOCKOUT_MS;
    const retryInSeconds = Math.ceil(GATE_LOCKOUT_MS / 1000);
    return {
      kind: 'locked',
      state: { challenge, misses: 0, lockedUntil },
      message: lockMessage(retryInSeconds),
      retryInSeconds,
    };
  }
  return {
    kind: 'wrong',
    state: { challenge, misses, lockedUntil: null },
    message: 'That’s not it. Here is a new one to try.',
    counted: true,
  };
}

export interface DeviceNameChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Device names a child can pick at pairing (PLAY-05): a fixed list instead of free text, so a child
 * cannot type a personal name into it. The first entry is the platform default; a parent can rename
 * the device later in the parent area.
 */
export function deviceNameChoices(
  platform: 'ios' | 'android' | 'web',
): readonly DeviceNameChoice[] {
  const names = [
    defaultDeviceLabel(platform),
    'My tablet',
    'My phone',
    'Family tablet',
    'Family computer',
  ];
  return [...new Set(names)].map((name) => ({ value: name, label: name }));
}

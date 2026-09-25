import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  answerGate,
  deviceNameChoices,
  GATE_FACTOR_MAX,
  GATE_FACTOR_MIN,
  GATE_LOCKOUT_MS,
  GATE_MAX_MISSES,
  gateLock,
  newChallenge,
  openGate,
  type GateState,
} from './parental-gate.ts';
import { defaultDeviceLabel } from './pairing-code.ts';

const T0 = Date.parse('2026-09-25T15:00:00.000Z');
const fixed = (value: number) => () => value;

/** A state whose challenge is known, so answers can be chosen deliberately. */
function knownGate(now = T0): GateState {
  return openGate(now, fixed(0.5)); // 6 × 6
}

describe('parental gate challenge (APL-02 / PLAY-07)', () => {
  it('draws two factors within the documented bounds, never trivial ones', () => {
    expect(GATE_FACTOR_MIN).toBeGreaterThanOrEqual(3);
    expect(GATE_FACTOR_MAX).toBeLessThanOrEqual(9);
    expect(newChallenge(fixed(0))).toMatchObject({ left: GATE_FACTOR_MIN, right: GATE_FACTOR_MIN });
    expect(newChallenge(fixed(0.999999))).toMatchObject({
      left: GATE_FACTOR_MAX,
      right: GATE_FACTOR_MAX,
    });
    for (let i = 0; i < 500; i += 1) {
      const c = newChallenge();
      expect(Number.isInteger(c.left) && Number.isInteger(c.right)).toBe(true);
      expect(c.left).toBeGreaterThanOrEqual(GATE_FACTOR_MIN);
      expect(c.left).toBeLessThanOrEqual(GATE_FACTOR_MAX);
      expect(c.right).toBeGreaterThanOrEqual(GATE_FACTOR_MIN);
      expect(c.right).toBeLessThanOrEqual(GATE_FACTOR_MAX);
      expect(c.answer).toBe(c.left * c.right);
    }
  });

  it('asks a grown-up, in words, with the product to type', () => {
    const c = newChallenge(fixed(0.5));
    expect(c).toMatchObject({ left: 6, right: 6, answer: 36 });
    expect(c.prompt).toBe('Ask a grown-up: what is 6 × 6?');
  });

  it('a correct answer passes, with spaces and leading zeros tolerated', () => {
    for (const input of ['36', ' 36 ', '036']) {
      const outcome = answerGate(knownGate(), input, T0);
      expect(outcome.kind).toBe('passed');
      expect(outcome.state.misses).toBe(0);
      expect(outcome.state.lockedUntil).toBeNull();
    }
  });

  it('a wrong answer counts a miss, says so calmly and draws a new challenge', () => {
    const outcome = answerGate(knownGate(), '35', T0, fixed(0));
    expect(outcome.kind).toBe('wrong');
    if (outcome.kind !== 'wrong') return;
    expect(outcome.counted).toBe(true);
    expect(outcome.state.misses).toBe(1);
    expect(outcome.state.challenge).toMatchObject({ left: 3, right: 3 });
    expect(outcome.message).toMatch(/not it/i);
    expect(outcome.message).not.toMatch(/36/);
  });

  it('an empty or non-numeric answer is not a miss', () => {
    for (const input of ['', '   ', 'six', '3x6']) {
      const outcome = answerGate(knownGate(), input, T0);
      expect(outcome.kind).toBe('wrong');
      if (outcome.kind !== 'wrong') return;
      expect(outcome.counted).toBe(false);
      expect(outcome.state.misses).toBe(0);
    }
  });

  it('locks for a short while after three misses, and the lock survives reopening', () => {
    expect(GATE_MAX_MISSES).toBe(3);
    expect(GATE_LOCKOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(GATE_LOCKOUT_MS).toBeLessThanOrEqual(5 * 60_000);
    let state = knownGate();
    for (let i = 0; i < GATE_MAX_MISSES; i += 1) {
      const outcome = answerGate(state, '1', T0 + i, fixed(0.5));
      state = outcome.state;
      if (i < GATE_MAX_MISSES - 1) expect(outcome.kind).toBe('wrong');
      else expect(outcome.kind).toBe('locked');
    }
    expect(state.lockedUntil).toBe(T0 + GATE_MAX_MISSES - 1 + GATE_LOCKOUT_MS);
    expect(gateLock(state, T0 + 10)).toEqual({
      locked: true,
      retryInSeconds: Math.ceil((GATE_LOCKOUT_MS - 8) / 1000),
    });
    // Even the right answer is refused while locked.
    const refused = answerGate(state, '36', T0 + 10);
    expect(refused.kind).toBe('locked');
    expect(refused.state).toBe(state);
    if (refused.kind === 'locked') expect(refused.message).toMatch(/wait/i);
    // Cancelling and reopening the gate keeps the lock.
    const reopened = openGate(T0 + 20, fixed(0.5), state);
    expect(gateLock(reopened, T0 + 20).locked).toBe(true);
    // After the lock ends the count starts over and a fresh challenge is drawn.
    const later = T0 + GATE_LOCKOUT_MS + 1000;
    expect(gateLock(state, later)).toEqual({ locked: false });
    const fresh = openGate(later, fixed(0.5), state);
    expect(fresh.misses).toBe(0);
    expect(fresh.lockedUntil).toBeNull();
    expect(answerGate(fresh, '36', later).kind).toBe('passed');
  });

  it('misses reset after a pass, so a grown-up who slipped once is not locked later', () => {
    const missed = answerGate(knownGate(), '1', T0, fixed(0.5)).state;
    const passed = answerGate(missed, '36', T0 + 1);
    expect(passed.kind).toBe('passed');
    expect(passed.state.misses).toBe(0);
  });
});

describe('device name at pairing is a fixed choice (PLAY-05)', () => {
  it('offers short preset names only, starting with the platform default', () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      const choices = deviceNameChoices(platform);
      expect(choices.length).toBeGreaterThanOrEqual(3);
      expect(choices[0]).toEqual({
        value: defaultDeviceLabel(platform),
        label: defaultDeviceLabel(platform),
      });
      expect(new Set(choices.map((c) => c.value)).size).toBe(choices.length);
      for (const choice of choices) {
        expect(choice.label).toBe(choice.value);
        // Fits the pairing contract (deviceLabel: 1–60 chars) and names no person.
        expect(choice.value.length).toBeGreaterThan(0);
        expect(choice.value.length).toBeLessThanOrEqual(60);
        expect(choice.value).not.toMatch(/name|riley|sam|jordan/i);
      }
    }
  });
});

const appDir = join(import.meta.dirname, '..', '..', 'app');
const source = (rel: string) => readFileSync(join(appDir, rel), 'utf8');

describe('screens reachable without the parent PIN use the gate (APL-02 / PLAY-07, PLAY-05)', () => {
  it('sign-in opens no outbound link without the parental gate', () => {
    const signIn = source('(parent)/sign-in.tsx');
    expect(signIn).not.toMatch(/Linking\.openURL/);
    expect(signIn).toContain('GatedLinkButton');
    expect(signIn).toContain('LegalLinks');
  });

  it('the child scan screen has no plain "Open Settings" button', () => {
    const scan = source('(child)/scan.tsx');
    expect(scan).not.toMatch(/label="Open Settings"/);
    expect(scan).not.toMatch(/onPress=\{\(\) => void openSettings\(\)\}/);
    expect(scan).toContain('GatedButton');
  });

  it('the pairing screen offers device names as a fixed choice, not free text', () => {
    const pair = source('pair.tsx');
    expect(pair).not.toContain('onChangeText={setLabel}');
    expect(pair).not.toMatch(/accessibilityLabel="Device name"/);
    expect(pair).toContain('deviceNameChoices');
  });

  it('the parent home and plan screens show the privacy policy and terms links', () => {
    expect(source('(parent)/home.tsx')).toContain('LegalLinks');
    expect(source('(parent)/plan.tsx')).toContain('LegalLinks');
  });
});

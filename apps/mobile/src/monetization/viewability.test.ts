import { describe, expect, it } from 'vitest';
import {
  createViewabilityTracker,
  createViewportSignal,
  visibleRatio,
  type ViewableMeasure,
} from './viewability.ts';

/** Manual clock and timers so each millisecond is explicit. */
function harness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sent: ViewableMeasure[] = [];
  const tracker = createViewabilityTracker({
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    onViewable: (measure) => sent.push(measure),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { tracker, advance, sent, pending: () => timers.size };
}

describe('visibleRatio', () => {
  it('measures the share of the card inside the viewport', () => {
    expect(visibleRatio({ top: 100, height: 200 }, { top: 0, height: 800 })).toBe(1);
    expect(visibleRatio({ top: 700, height: 200 }, { top: 0, height: 800 })).toBe(0.5);
    expect(visibleRatio({ top: 900, height: 200 }, { top: 0, height: 800 })).toBe(0);
    expect(visibleRatio({ top: 900, height: 200 }, { top: 250, height: 800 })).toBe(0.75);
  });

  it('is 0 until real layout values exist', () => {
    expect(visibleRatio({ top: 0, height: 0 }, { top: 0, height: 800 })).toBe(0);
    expect(visibleRatio({ top: 0, height: 200 }, { top: 0, height: 0 })).toBe(0);
  });
});

describe('viewability tracker (spec P16.5; AC_MON_16)', () => {
  it('reports once after 50% visibility for 1000 ms in the foreground', () => {
    const { tracker, advance, sent } = harness();
    tracker.update({ ratio: 0.6, appActive: true });
    advance(999);
    expect(sent).toHaveLength(0);
    advance(1);
    expect(sent).toEqual([{ visibleMs: 1000, visibleRatio: 0.6 }]);
    expect(tracker.sent).toBe(true);
    tracker.update({ ratio: 0, appActive: true });
    tracker.update({ ratio: 1, appActive: true });
    advance(5000);
    expect(sent).toHaveLength(1);
  });

  it('never reports a card that is less than half visible', () => {
    const { tracker, advance, sent } = harness();
    tracker.update({ ratio: 0.49, appActive: true });
    advance(10_000);
    expect(sent).toHaveLength(0);
  });

  it('restarts the timer when the card leaves the viewport', () => {
    const { tracker, advance, sent } = harness();
    tracker.update({ ratio: 0.8, appActive: true });
    advance(600);
    tracker.update({ ratio: 0.2, appActive: true });
    advance(600);
    tracker.update({ ratio: 0.8, appActive: true });
    advance(999);
    expect(sent).toHaveLength(0);
    advance(1);
    expect(sent).toHaveLength(1);
  });

  it('never reports while the app is in the background', () => {
    const { tracker, advance, sent, pending } = harness();
    tracker.update({ ratio: 1, appActive: false });
    advance(10_000);
    expect(sent).toHaveLength(0);
    tracker.update({ ratio: 1, appActive: true });
    advance(500);
    tracker.update({ ratio: 1, appActive: false });
    expect(pending()).toBe(0);
    advance(10_000);
    expect(sent).toHaveLength(0);
  });

  it('stops after dispose and ignores invalid measurements', () => {
    const { tracker, advance, sent } = harness();
    tracker.update({ ratio: Number.NaN, appActive: true });
    advance(5000);
    tracker.update({ ratio: 1, appActive: true });
    tracker.dispose();
    advance(5000);
    expect(sent).toHaveLength(0);
  });
});

describe('viewport signal', () => {
  it('merges partial updates and notifies subscribers until they unsubscribe', () => {
    const signal = createViewportSignal();
    const seen: number[] = [];
    const stop = signal.subscribe((v) => seen.push(v.top));
    signal.set({ height: 800 });
    signal.set({ top: 120 });
    expect(signal.get()).toEqual({ top: 120, height: 800 });
    stop();
    signal.set({ top: 300 });
    expect(seen).toEqual([0, 120]);
  });
});

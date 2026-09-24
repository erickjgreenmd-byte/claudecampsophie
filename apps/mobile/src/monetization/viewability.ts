import { DEFAULT_PLACEMENT_RULE } from '@pencillift/domain/monetization';

/**
 * Viewability for the mobile sponsor card (spec P16.5; AC_MON_16). React Native has no
 * IntersectionObserver, so the screen feeds scroll/layout measurements and the app state into this
 * pure tracker. The "viewed" beacon fires at most once, only after the card has been at least 50%
 * on screen for 1000 ms while the app is in the foreground. Nothing is measured, and nothing is
 * sent, until real layout values exist.
 */

export const VIEWABLE_MIN_MS = DEFAULT_PLACEMENT_RULE.minVisibleMs;
export const VIEWABLE_MIN_RATIO = DEFAULT_PLACEMENT_RULE.minVisibleRatio;

/** A vertical span in scroll-content coordinates. */
export interface Span {
  readonly top: number;
  readonly height: number;
}

/** Share (0..1) of `card` inside `viewport`; 0 when either has no measured height yet. */
export function visibleRatio(card: Span, viewport: Span): number {
  if (!(card.height > 0) || !(viewport.height > 0)) return 0;
  const top = Math.max(card.top, viewport.top);
  const bottom = Math.min(card.top + card.height, viewport.top + viewport.height);
  const visible = Math.max(0, bottom - top);
  return Math.min(1, visible / card.height);
}

export interface ViewableMeasure {
  readonly visibleMs: number;
  readonly visibleRatio: number;
}

export interface ViewabilityTracker {
  /** Latest measurement: share of the card on screen and whether the app is in the foreground. */
  update(state: { readonly ratio: number; readonly appActive: boolean }): void;
  dispose(): void;
  readonly sent: boolean;
}

export function createViewabilityTracker(options: {
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly onViewable: (measure: ViewableMeasure) => void;
  readonly minVisibleMs?: number;
  readonly minVisibleRatio?: number;
}): ViewabilityTracker {
  const minMs = options.minVisibleMs ?? VIEWABLE_MIN_MS;
  const minRatio = options.minVisibleRatio ?? VIEWABLE_MIN_RATIO;
  let sent = false;
  let disposed = false;
  let ratio = 0;
  let active = false;
  let startedAt = 0;
  let timer: unknown = null;

  const qualifies = () => !sent && !disposed && active && ratio >= minRatio;
  const stop = () => {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
  };

  return {
    update(state) {
      ratio = Number.isFinite(state.ratio) ? Math.min(1, Math.max(0, state.ratio)) : 0;
      active = state.appActive;
      if (!qualifies()) {
        stop();
        return;
      }
      if (timer !== null) return;
      startedAt = options.now();
      timer = options.setTimer(() => {
        timer = null;
        if (!qualifies()) return;
        sent = true;
        options.onViewable({
          visibleMs: Math.min(3_600_000, Math.max(0, Math.round(options.now() - startedAt))),
          visibleRatio: Math.round(ratio * 100) / 100,
        });
      }, minMs);
    },
    dispose() {
      disposed = true;
      stop();
    },
    get sent() {
      return sent;
    },
  };
}

/** Latest scroll viewport, shared between the screen's ScrollView and the sponsor card. */
export interface ViewportSignal {
  get(): Span;
  set(next: Partial<Span>): void;
  subscribe(listener: (viewport: Span) => void): () => void;
}

export function createViewportSignal(): ViewportSignal {
  let current: Span = { top: 0, height: 0 };
  const listeners = new Set<(viewport: Span) => void>();
  return {
    get: () => current,
    set(next) {
      current = { top: next.top ?? current.top, height: next.height ?? current.height };
      for (const listener of [...listeners]) listener(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

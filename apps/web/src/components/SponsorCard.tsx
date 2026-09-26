import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { z } from 'zod';
import {
  placementClickResponseSchema,
  placementResponseSchema,
  placementViewedResponseSchema,
  type SponsorCard as SponsorCardDto,
  type adReportCategorySchema,
  type placementSchema,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { DEFAULT_PLACEMENT_RULE } from '@pencillift/domain/monetization';
import { useSession } from '../lib/session.tsx';
import { StepUpPrompt } from './StepUpPrompt.tsx';

/**
 * One first-party sponsor card for an adult surface (spec P16.1, P16.5; AC_MON_03/05/08/16).
 *
 * - The slot asks the API once per screen. It never refreshes, polls or retries, so at most one
 *   card is shown and a dismissed card is never replaced.
 * - Card text is rendered as plain text. There is no advertiser HTML, script, pixel or remote
 *   image here.
 * - Dismiss and report are buttons that never navigate. The sponsor's site opens only after the
 *   adult taps the call to action, in a new browsing context with no opener and no referrer.
 * - The "viewed" beacon is sent once, only after the card has been at least 50% visible for
 *   1000 ms while the page is visible (IntersectionObserver). Without IntersectionObserver it is
 *   never sent, so a hidden or prefetched card can never count as an impression.
 */

export type Placement = z.infer<typeof placementSchema>;
type ReportCategory = z.infer<typeof adReportCategorySchema>;

/** Viewability rule mirrored from the domain default (the server re-checks every beacon). */
export const VIEWABLE_MIN_MS = DEFAULT_PLACEMENT_RULE.minVisibleMs;
export const VIEWABLE_MIN_RATIO = DEFAULT_PLACEMENT_RULE.minVisibleRatio;

/** Dismiss and report return 204: the client reads an empty body as null. */
const noContentSchema = z.null();

/**
 * Opens an https destination only in a new browsing context, with no opener and no referrer
 * (spec P16.3). It is called only from an adult's click handler.
 */
export function openOutside(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only https destinations can be opened');
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

/** Two-letter-language + region locale for the API ("en-US"), or null to use the server default. */
export function clientLocale(): string | null {
  const value = typeof navigator === 'undefined' ? '' : navigator.language;
  return /^[a-z]{2}-[A-Z]{2}$/.test(value) ? value : null;
}

const REPORT_OPTIONS: readonly { value: ReportCategory; label: string }[] = [
  { value: 'inappropriate', label: 'Inappropriate for a family learning app' },
  { value: 'misleading', label: 'Misleading' },
  { value: 'irrelevant', label: 'Not relevant to learning' },
  { value: 'other', label: 'Something else' },
];

const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
const wrapText = { overflowWrap: 'anywhere', whiteSpace: 'normal' } as const;

/**
 * Sends `onViewed` at most once, after `target` has been at least VIEWABLE_MIN_RATIO visible for
 * VIEWABLE_MIN_MS in a visible document. Leaving the viewport or hiding the page resets the timer.
 */
export function useViewedBeacon(
  target: RefObject<HTMLElement | null>,
  onViewed: (measure: { visibleMs: number; visibleRatio: number }) => void,
): void {
  const sent = useRef(false);
  const callback = useRef(onViewed);
  useEffect(() => {
    callback.current = onViewed;
  }, [onViewed]);

  useEffect(() => {
    const element = target.current;
    if (!element || sent.current) return;
    // No IntersectionObserver means no trustworthy measurement: never report a view.
    if (typeof IntersectionObserver === 'undefined') return;

    let ratio = 0;
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pageVisible = () => document.visibilityState === 'visible';
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const maybeStart = () => {
      if (sent.current || timer !== null) return;
      if (ratio < VIEWABLE_MIN_RATIO || !pageVisible()) return;
      startedAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        if (sent.current || ratio < VIEWABLE_MIN_RATIO || !pageVisible()) return;
        sent.current = true;
        observer.disconnect();
        callback.current({
          visibleMs: Math.min(3_600_000, Math.max(0, Math.round(Date.now() - startedAt))),
          visibleRatio: Math.min(1, Math.round(ratio * 100) / 100),
        });
      }, VIEWABLE_MIN_MS);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        if (ratio >= VIEWABLE_MIN_RATIO) maybeStart();
        else stop();
      },
      { threshold: [0, 0.25, VIEWABLE_MIN_RATIO, 0.75, 1] },
    );
    observer.observe(element);
    const onVisibility = () => {
      if (pageVisible()) maybeStart();
      else stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [target]);
}

function placementPath(placement: Placement): string {
  const query = new URLSearchParams({ placement, platform: 'web' });
  const locale = clientLocale();
  if (locale) query.set('locale', locale);
  return `/v1/placements?${query.toString()}`;
}

/**
 * The single commercial slot of a screen. It requests one card the first time `enabled` is true
 * and never again while mounted. Nothing renders when no card is served.
 */
export function SponsorSlot({ placement, enabled }: { placement: Placement; enabled: boolean }) {
  const { api } = useSession();
  const requested = useRef(false);
  const mounted = useRef(true);
  const [card, setCard] = useState<SponsorCardDto | null>(null);
  const [closedMessage, setClosedMessage] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;
    api.get(placementPath(placement), placementResponseSchema).then(
      (response) => {
        // A card for another placement is never shown here.
        if (mounted.current && response.card && response.card.placement === placement) {
          setCard(response.card);
        }
      },
      // Commercial content is optional: a failure shows nothing and never blocks the page.
      () => undefined,
    );
  }, [api, enabled, placement]);

  if (!enabled) return null;
  if (card === null) {
    return closedMessage ? (
      <p role="status" style={{ color: 'var(--muted)', marginTop: 32 }}>
        {closedMessage}
      </p>
    ) : null;
  }
  return (
    <SponsorCard
      card={card}
      onClosed={(message) => {
        setCard(null);
        setClosedMessage(message);
      }}
    />
  );
}

type CardProblem = { message: string; stepUp: boolean };

function problemFor(error: unknown, fallback: string): CardProblem {
  if (!(error instanceof ApiRequestError)) return { message: fallback, stepUp: false };
  if (error.code === 'STEP_UP_REQUIRED') {
    return { message: 'Enter your parent PIN to continue.', stepUp: true };
  }
  if (error.code === 'NETWORK') return { message: error.message, stepUp: false };
  return { message: fallback, stepUp: false };
}

/** A served sponsor card: label, why it is shown, plain-text creative and adult controls. */
export function SponsorCard({
  card,
  onClosed,
}: {
  card: SponsorCardDto;
  onClosed: (message: string) => void;
}) {
  const { api } = useSession();
  const ids = useId();
  const labelId = `${ids}-label`;
  const whyId = `${ids}-why`;
  const leaveId = `${ids}-leave`;
  const reportHeadingId = `${ids}-report`;
  const root = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState<'open' | 'report' | null>(null);
  const [reporting, setReporting] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [problem, setProblem] = useState<CardProblem | null>(null);
  const token = encodeURIComponent(card.serveToken);

  useViewedBeacon(root, (measure) => {
    // Best effort and counted server-side at most once; a failure never changes the page.
    api
      .send('POST', `/v1/placements/${token}/viewed`, measure, placementViewedResponseSchema)
      .catch(() => undefined);
  });

  // "Sponsored by <business>" comes from the server; anything else is shown as an advertisement.
  const label = card.label.startsWith('Sponsored by ')
    ? card.label
    : `Advertisement: ${card.label}`;

  const open = async () => {
    setBusy('open');
    setProblem(null);
    try {
      const { url } = await api.send(
        'POST',
        `/v1/placements/${token}/click`,
        undefined,
        placementClickResponseSchema,
      );
      openOutside(url);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
        onClosed('This sponsored card is no longer available.');
        return;
      }
      setProblem(problemFor(error, 'We couldn’t open this offer. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const dismiss = () => {
    // Dismissal is a safety control: the card leaves the screen at once, whatever the network does.
    api
      .send('POST', `/v1/placements/${token}/dismiss`, undefined, noContentSchema)
      .catch(() => undefined);
    onClosed('Sponsored card dismissed.');
  };

  const sendReport = async () => {
    if (category === null) {
      setProblem({ message: 'Choose what is wrong with this card.', stepUp: false });
      return;
    }
    setBusy('report');
    setProblem(null);
    try {
      await api.send('POST', `/v1/placements/${token}/report`, { category }, noContentSchema);
      onClosed('Thank you. The sponsored card was reported and hidden. We review every report.');
    } catch (error) {
      setProblem(problemFor(error, 'We couldn’t send the report. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside
      ref={root}
      className="card sponsored"
      aria-labelledby={labelId}
      aria-describedby={whyId}
      style={{ marginTop: 32, ...wrapText }}
    >
      <p id={labelId} style={{ margin: 0, fontWeight: 800 }}>
        {label}
      </p>
      <p id={whyId} style={{ margin: '4px 0 12px', color: 'var(--muted)' }}>
        {card.whyShown}
      </p>
      {card.headline ? <p style={{ margin: '0 0 4px', fontWeight: 700 }}>{card.headline}</p> : null}
      {card.body ? <p style={{ margin: 0 }}>{card.body}</p> : null}
      <div style={{ ...buttonRow, alignItems: 'center' }}>
        <button
          type="button"
          className="btn"
          aria-describedby={`${labelId} ${leaveId}`}
          disabled={busy !== null}
          onClick={() => void open()}
        >
          {busy === 'open' ? 'Opening…' : card.ctaLabel || 'Visit sponsor'}
        </button>
        <span id={leaveId} style={wrapText}>
          {card.destinationHost
            ? `Opens ${card.destinationHost} in a new tab. You will leave PencilLift.`
            : 'Opens the sponsor’s site in a new tab. You will leave PencilLift.'}
        </span>
      </div>
      <div style={buttonRow}>
        <button type="button" className="btn secondary" onClick={dismiss}>
          Dismiss
        </button>
        {reporting ? null : (
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            onClick={() => {
              setReporting(true);
              setProblem(null);
            }}
          >
            Report this ad
          </button>
        )}
      </div>
      {reporting ? (
        <fieldset
          aria-labelledby={reportHeadingId}
          style={{ border: 0, padding: 0, margin: '12px 0 0' }}
        >
          <legend id={reportHeadingId} style={{ fontWeight: 700 }}>
            What is wrong with this card?
          </legend>
          {REPORT_OPTIONS.map((option) => (
            <label
              key={option.value}
              style={{ fontWeight: 400, display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <input
                type="radio"
                name={`${ids}-category`}
                value={option.value}
                checked={category === option.value}
                onChange={() => setCategory(option.value)}
              />
              {option.label}
            </label>
          ))}
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void sendReport()}
            >
              {busy === 'report' ? 'Sending…' : 'Send report'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() => {
                setReporting(false);
                setCategory(null);
                setProblem(null);
              }}
            >
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
      {problem && !problem.stepUp ? (
        <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>
          {problem.message}
        </p>
      ) : null}
      {problem?.stepUp ? (
        /*
          WEB-R2-05: the fifth copy of the link-only step-up notice. Following the link to
          /app/security unmounted this card, so the report category the adult had chosen was lost and
          the card itself was gone when they came back. The shared prompt keeps the same link (same
          name and href) but takes the PIN here and carries the return path as router state.
        */
        <StepUpPrompt
          explanation="Reporting a sponsored card needs a recent PIN unlock."
          retryHint={() => 'Press “Send report” again to continue.'}
        />
      ) : null}
    </aside>
  );
}

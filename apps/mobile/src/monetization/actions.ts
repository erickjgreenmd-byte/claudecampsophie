import {
  monetizationPreferencesSchema,
  outboundUrlResponseSchema,
  placementClickResponseSchema,
  placementResponseSchema,
  placementViewedResponseSchema,
  resourceItemSchema,
  resourcesResponseSchema,
  type MonetizationPreferences,
  type PlacementResponse,
  type ResourcesResponse,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import type { AppMode } from '../lib/mode.ts';
import type { ViewableMeasure } from './viewability.ts';
import {
  monetizationError,
  outboundPath,
  placementPath,
  resourcesPath,
  type MerchantMode,
  type MonetizationProblem,
  type Platform,
  type ReportCategory,
  type ResourceFilters,
  type ResourcePlacement,
} from './view-model.ts';

/**
 * API calls for the parent Resources screen (spec P16; AC_MON_02/03/05/11/12). Pure: no
 * react-native imports, so the rules are unit-tested. Outside a parent session nothing here makes
 * a request: child mode, signed-out mode and unknown roles get no commercial DTO at all.
 *
 * Links open through the injected `openUrl`, which the screen wires to React Native's
 * `Linking.openURL` (the system browser or the merchant's own app). There is no WebView or
 * in-app browser, and nothing opens without a deliberate adult tap.
 */

export type OpenUrl = (url: string) => Promise<unknown>;

/** Dismiss and report answer 204; the client reads the empty body as null (contract z.null()). */
const noContentSchema = resourceItemSchema.shape.price;

function isParent(mode: AppMode): boolean {
  return mode === 'parent';
}

/** Opens only an https destination; anything else is refused before it reaches the OS. */
async function openHttps(openUrl: OpenUrl, url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only https destinations can be opened');
  await openUrl(parsed.href);
  return parsed.hostname;
}

export async function loadResources(
  api: ApiClient,
  mode: AppMode,
  filters: ResourceFilters,
  platform: Platform,
  locale: string | null,
): Promise<ResourcesResponse | null> {
  if (!isParent(mode)) return null;
  return api.get(resourcesPath(filters, platform, locale), resourcesResponseSchema);
}

export async function loadPreferences(
  api: ApiClient,
  mode: AppMode,
): Promise<MonetizationPreferences | null> {
  if (!isParent(mode)) return null;
  return api.get('/v1/monetization/preferences', monetizationPreferencesSchema);
}

export type SaveOutcome =
  | { readonly ok: true; readonly prefs: MonetizationPreferences; readonly message: string }
  | ({ readonly ok: false } & MonetizationProblem);

export async function savePreferences(
  api: ApiClient,
  mode: AppMode,
  prefs: MonetizationPreferences,
): Promise<SaveOutcome> {
  if (!isParent(mode))
    return { ok: false, message: 'Unlock the parent area first.', needsPin: true };
  try {
    const saved = await api.send(
      'PUT',
      '/v1/monetization/preferences',
      prefs,
      monetizationPreferencesSchema,
    );
    return { ok: true, prefs: saved, message: 'Your choices are saved for your family.' };
  } catch (error) {
    return { ok: false, ...monetizationError(error, 'load') };
  }
}

/**
 * Asks for at most one sponsor card. No request is made outside parent mode or when the family
 * hides sponsor cards. Failures are swallowed: commercial content never blocks the screen.
 */
export async function loadSponsorCard(
  api: ApiClient,
  mode: AppMode,
  prefs: MonetizationPreferences | null,
  placement: ResourcePlacement,
  platform: Platform,
  locale: string | null,
): Promise<PlacementResponse | null> {
  if (!isParent(mode) || prefs === null || prefs.hideSponsorCards) return null;
  try {
    return await api.get(placementPath(placement, platform, locale), placementResponseSchema);
  } catch {
    return null;
  }
}

export type LinkOutcome =
  | { readonly kind: 'opened'; readonly host: string }
  /** The link's mode changed since the list loaded: show the new disclosure, do not open. */
  | { readonly kind: 'changed'; readonly mode: MerchantMode }
  | ({ readonly kind: 'error' } & MonetizationProblem);

export async function openResourceLink(
  api: ApiClient,
  mode: AppMode,
  item: { readonly id: string; readonly shownMode: MerchantMode },
  platform: Platform,
  locale: string | null,
  openUrl: OpenUrl,
): Promise<LinkOutcome> {
  if (!isParent(mode)) {
    return { kind: 'error', message: 'Unlock the parent area first.', needsPin: true };
  }
  try {
    const outbound = await api.get(
      outboundPath(item.id, platform, locale),
      outboundUrlResponseSchema,
    );
    // Never open a link under a disclosure the parent has not seen.
    if (outbound.mode !== item.shownMode) return { kind: 'changed', mode: outbound.mode };
    return { kind: 'opened', host: await openHttps(openUrl, outbound.url) };
  } catch (error) {
    return { kind: 'error', ...monetizationError(error, 'link') };
  }
}

export type SponsorOutcome =
  | { readonly kind: 'opened'; readonly host: string }
  | { readonly kind: 'gone'; readonly message: string }
  | ({ readonly kind: 'error' } & MonetizationProblem);

function tokenPath(serveToken: string, action: string): string {
  return `/v1/placements/${encodeURIComponent(serveToken)}/${action}`;
}

/** The sponsor's reviewed destination, opened only after the adult taps the call to action. */
export async function openSponsorLink(
  api: ApiClient,
  mode: AppMode,
  card: { readonly serveToken: string },
  openUrl: OpenUrl,
): Promise<SponsorOutcome> {
  if (!isParent(mode)) {
    return { kind: 'error', message: 'Unlock the parent area first.', needsPin: true };
  }
  try {
    const { url } = await api.send(
      'POST',
      tokenPath(card.serveToken, 'click'),
      undefined,
      placementClickResponseSchema,
    );
    return { kind: 'opened', host: await openHttps(openUrl, url) };
  } catch (error) {
    // A withdrawn card (kill switch, pause, expiry, cap) leaves the screen.
    if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') {
      return { kind: 'gone', message: monetizationError(error, 'sponsor').message };
    }
    return { kind: 'error', ...monetizationError(error, 'sponsor') };
  }
}

/** Dismissal is a safety control: best effort, and the card leaves the screen regardless. */
export async function dismissSponsorCard(
  api: ApiClient,
  card: { readonly serveToken: string },
): Promise<void> {
  await api
    .send('POST', tokenPath(card.serveToken, 'dismiss'), undefined, noContentSchema)
    .catch(() => undefined);
}

export type ReportOutcome =
  { readonly ok: true; readonly message: string } | ({ readonly ok: false } & MonetizationProblem);

export async function reportSponsorCard(
  api: ApiClient,
  card: { readonly serveToken: string },
  category: ReportCategory,
): Promise<ReportOutcome> {
  try {
    await api.send('POST', tokenPath(card.serveToken, 'report'), { category }, noContentSchema);
    return {
      ok: true,
      message: 'Thank you. The sponsored card was reported and hidden. We review every report.',
    };
  } catch (error) {
    return { ok: false, ...monetizationError(error, 'sponsor') };
  }
}

/** Best-effort viewability beacon; the server re-checks every rule and counts at most once. */
export async function sendViewed(
  api: ApiClient,
  card: { readonly serveToken: string },
  measure: ViewableMeasure,
): Promise<void> {
  await api
    .send('POST', tokenPath(card.serveToken, 'viewed'), measure, placementViewedResponseSchema)
    .catch(() => undefined);
}

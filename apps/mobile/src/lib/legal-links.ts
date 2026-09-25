/**
 * Privacy policy and terms of use links (store compliance APL-06 / PLAY-20). Both pages live on the
 * public parent portal (the privacy and terms pages in apps/web/src/routes.tsx). Pure: the configured
 * portal origin is passed in (see `portalUrl` in ./parent-auth.ts). Only an absolute https origin
 * yields links: the app never opens a relative path, a plain-http address or a made-up domain.
 */

export type LegalLinkKey = 'privacy' | 'terms';

export interface LegalLink {
  readonly key: LegalLinkKey;
  readonly label: string;
  readonly url: string;
}

export const LEGAL_LINK_LABELS: Readonly<Record<LegalLinkKey, string>> = {
  privacy: 'Privacy policy',
  terms: 'Terms of use',
};

const KEYS: readonly LegalLinkKey[] = ['privacy', 'terms'];

function httpsOrigin(portalUrl: string | null): string | null {
  if (!portalUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(portalUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** The legal links for a configured portal origin, or an empty list when none is configured. */
export function legalLinks(portalUrl: string | null): readonly LegalLink[] {
  const origin = httpsOrigin(portalUrl);
  if (origin === null) return [];
  return KEYS.map((key) => ({ key, label: LEGAL_LINK_LABELS[key], url: `${origin}/${key}` }));
}

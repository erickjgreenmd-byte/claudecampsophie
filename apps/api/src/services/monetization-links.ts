import type { ApiConfig } from '../config.ts';

/**
 * Admin link validation for the reviewed resource catalog (spec P10: "admin link validation and
 * graceful unavailable products"). One HEAD request with a 5 s timeout against the canonical,
 * UNTAGGED merchant URL (never an affiliate link, so a check can never register as a click).
 * The fetch is injectable; in the `test` environment no live request is ever made unless a test
 * installs a stub.
 */

export type LinkCheckFetch = (
  url: string,
  init: { method: 'HEAD'; redirect: 'manual'; signal: AbortSignal },
) => Promise<{ status: number }>;

let testFetch: LinkCheckFetch | null = null;

/** Test hook: install a stub fetch (or null to remove it). Never used by production code. */
export function setLinkCheckFetchForTests(fetcher: LinkCheckFetch | null): void {
  testFetch = fetcher;
}

export const LINK_CHECK_TIMEOUT_MS = 5000;

export interface LinkCheckResult {
  readonly status: 'ok' | 'broken' | 'error' | 'skipped';
  readonly httpStatus: number | null;
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly note: string | null;
}

export async function checkMerchantLink(
  config: ApiConfig,
  url: string | null,
): Promise<LinkCheckResult> {
  if (url === null) {
    return {
      status: 'skipped',
      httpStatus: null,
      availability: 'unknown',
      note: 'No merchant link',
    };
  }
  const fetcher: LinkCheckFetch | null =
    testFetch ??
    (config.environment === 'test'
      ? null
      : async (target, init) => {
          const response = await fetch(target, init);
          return { status: response.status };
        });
  if (fetcher === null) {
    return {
      status: 'skipped',
      httpStatus: null,
      availability: 'unknown',
      note: 'Live link checks are disabled in the test environment',
    };
  }
  try {
    const response = await fetcher(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 400) {
      return { status: 'ok', httpStatus: response.status, availability: 'available', note: null };
    }
    if (response.status === 404 || response.status === 410) {
      return {
        status: 'broken',
        httpStatus: response.status,
        availability: 'unavailable',
        note: 'The merchant page no longer exists',
      };
    }
    return {
      status: 'error',
      httpStatus: response.status,
      availability: 'unknown',
      note: 'The merchant did not confirm the page; check it manually',
    };
  } catch {
    return {
      status: 'error',
      httpStatus: null,
      availability: 'unknown',
      note: 'The link check timed out or failed',
    };
  }
}

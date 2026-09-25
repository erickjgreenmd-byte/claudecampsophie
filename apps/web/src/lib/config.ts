/**
 * Public build-time configuration. Only publishable values belong here (they ship to browsers).
 *
 * Two loud gates live in this module, both run once at startup (`assertWebEnv` below, and
 * `readWebConfig` from App.tsx):
 * - WEB-01: a production build (`import.meta.env.PROD`) without `VITE_API_BASE_URL`,
 *   `VITE_SUPABASE_URL` or `VITE_SUPABASE_PUBLISHABLE_KEY` throws instead of silently pointing the
 *   portal at `/api` with sign-in "not configured". Dev and test builds keep the local defaults.
 * - WEB-06 / APL-20: a build that records legal review (`VITE_LEGAL_REVIEWED=true`) must also carry
 *   `VITE_LEGAL_EFFECTIVE_DATE` (YYYY-MM-DD) and `VITE_SUPPORT_EMAIL`; without them the public legal
 *   pages would present a reviewed policy with no effective date and a placeholder mailbox.
 *
 * Vite inlines `import.meta.env` at build time, so these checks run against the values the build
 * was made with. The same functions can be called from a Vite plugin to fail `vite build` itself.
 */

export type WebEnv = Readonly<Record<string, unknown>>;

export interface WebConfig {
  readonly apiBaseUrl: string;
  readonly supabaseUrl: string | null;
  readonly supabasePublishableKey: string | null;
}

/** The public values every production build must be given (docs/Deployment_Runbook.md §3.5). */
export const REQUIRED_PRODUCTION_VARS = [
  'VITE_API_BASE_URL',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
] as const;

/** A configuration error found at startup: the message names the variables, never their values. */
export class WebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebConfigError';
  }
}

/** A trimmed string value, or null for a missing, blank or non-string one. */
function text(env: WebEnv, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Only a boolean `true` (what Vite emits for a production build) counts as production. */
function isProductionBuild(env: WebEnv): boolean {
  return env.PROD === true;
}

export function readWebConfig(env: WebEnv = import.meta.env): WebConfig {
  if (isProductionBuild(env)) {
    const missing = REQUIRED_PRODUCTION_VARS.filter((name) => text(env, name) === null);
    if (missing.length > 0) {
      throw new WebConfigError(
        `Production build is missing required public configuration: ${missing.join(', ')}. ` +
          'Set these build variables (docs/Deployment_Runbook.md §3.5) and rebuild.',
      );
    }
  }
  return {
    apiBaseUrl: text(env, 'VITE_API_BASE_URL') ?? '/api',
    supabaseUrl: text(env, 'VITE_SUPABASE_URL'),
    supabasePublishableKey: text(env, 'VITE_SUPABASE_PUBLISHABLE_KEY'),
  };
}

/**
 * True only when the build records that the owner and legal counsel reviewed the public legal and
 * support pages (`VITE_LEGAL_REVIEWED=true`).
 *
 * Decision: only the exact string "true" counts. A typo or "1" fails safe to the draft state,
 * because presenting an unreviewed draft as a final policy is the worse error.
 */
export function isLegalReviewed(env: WebEnv = import.meta.env): boolean {
  return env.VITE_LEGAL_REVIEWED === 'true';
}

/**
 * WEB-R1-11: true only when the build is made for store review or later, when the apps can be
 * downloaded and plans bought (`VITE_STORE_LIVE=true`). It switches off the public site's
 * pre-launch notices ("still being built", "not yet available"); it adds no startup gate.
 *
 * Decision: only the exact string "true" counts, as for VITE_LEGAL_REVIEWED. Anything else keeps the
 * pre-launch notices, because claiming availability too early is the worse error. The store review
 * build must set it (docs/Release_Readiness.md).
 */
export function isStoreLive(env: WebEnv = import.meta.env): boolean {
  return env.VITE_STORE_LIVE === 'true';
}

export interface LegalConfig {
  readonly reviewed: boolean;
  /** ISO calendar date (YYYY-MM-DD) the policy and terms take effect; null while a draft. */
  readonly effectiveDate: string | null;
  /** The monitored support mailbox; null until the owner confirms one. */
  readonly supportEmail: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is rejected). */
function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === value;
}

/** A single mailbox: one "@", a non-empty local part and a dotted domain, no whitespace. */
function isMailbox(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The legal-page configuration. A malformed date or mailbox throws in every mode (a typo must not
 * ship); a missing one throws only when the build claims legal review.
 */
export function readLegalConfig(env: WebEnv = import.meta.env): LegalConfig {
  const reviewed = isLegalReviewed(env);
  const effectiveDate = text(env, 'VITE_LEGAL_EFFECTIVE_DATE');
  const supportEmail = text(env, 'VITE_SUPPORT_EMAIL');
  const problems: string[] = [];
  if (effectiveDate !== null && !isCalendarDate(effectiveDate)) {
    problems.push('VITE_LEGAL_EFFECTIVE_DATE must be a calendar date in YYYY-MM-DD form');
  }
  if (supportEmail !== null && !isMailbox(supportEmail)) {
    problems.push('VITE_SUPPORT_EMAIL must be a single mailbox address');
  }
  if (reviewed) {
    if (effectiveDate === null) problems.push('VITE_LEGAL_EFFECTIVE_DATE is required');
    if (supportEmail === null) problems.push('VITE_SUPPORT_EMAIL is required');
  }
  if (problems.length > 0) {
    throw new WebConfigError(
      `${reviewed ? 'VITE_LEGAL_REVIEWED=true needs complete legal configuration' : 'Invalid legal configuration'}: ` +
        `${problems.join('; ')}. See docs/Deployment_Runbook.md §3.5.`,
    );
  }
  return { reviewed, effectiveDate, supportEmail };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "2026-10-01" → "October 1, 2026", without touching the browser's time zone or locale. */
export function formatEffectiveDate(isoDate: string): string {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new WebConfigError(`Not an ISO calendar date: ${isoDate}`);
  const [, y, mo, d] = m;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
}

/** Runs every startup gate against one environment; throws a WebConfigError on the first problem. */
export function assertWebEnv(env: WebEnv): void {
  readWebConfig(env);
  readLegalConfig(env);
}

// Fail at startup, before any page renders, rather than serving a misconfigured portal. Under vitest
// this sees the plain test environment (PROD false, nothing reviewed) and passes; tests exercise the
// gates by passing their own env objects.
// Vite defines import.meta.env only in transformed modules; vite.config.ts imports this file in
// Node to run the same gates at build time and passes the build's variables explicitly there.
if (typeof import.meta.env !== 'undefined') assertWebEnv(import.meta.env);

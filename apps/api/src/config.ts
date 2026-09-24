import { validateZdrEvidence } from '@pencillift/ai';
import { isValidIanaZone } from '@pencillift/domain';
import { SAFETY_TEMPLATES_APPROVED, SAFETY_TEMPLATES_STATUS } from '@pencillift/domain/safety';
import type { Db } from './db.ts';

/**
 * Runtime configuration. Only names appear in source; values come from Worker secrets/vars.
 * `productionReadiness()` is the AC_DEPLOY_07 report: every check must be ready before production
 * serves real families. Mock consent and mock billing are never wired outside development and test
 * (src/index.ts), and scans never reach a mock AI there (checkChildDataGate). Fake catalog data is
 * reported here and refused by a database marked production (migration 0770); nothing else stops a
 * production Worker from serving it while the database is unmarked, so an unmarked database blocks
 * readiness (`database_environment`).
 */

export type Environment = 'development' | 'test' | 'staging' | 'production';

export interface ZdrEvidence {
  /** Reference to the owner's documented OpenAI ZDR approval (ticket/contract id), never a boolean. */
  readonly reference: string;
  readonly verifiedAt: string;
}

export interface ApiConfig {
  readonly environment: Environment;
  readonly supabase: {
    /** Issuer expected in parent JWTs, e.g. https://<project>.supabase.co/auth/v1 */
    readonly jwtIssuer: string;
    /** Asymmetric signing keys endpoint (preferred). */
    readonly jwksUrl: string | null;
    /** Legacy/local HS256 secret. Only one of jwksUrl / jwtSecret is needed. */
    readonly jwtSecret: Uint8Array | null;
  };
  /** HS256 key for API-issued child tokens (>= 32 bytes). Never shared with Supabase. */
  readonly childTokenSecret: Uint8Array;
  /** Server-side pepper for PIN and pairing/promo code hashing (>= 32 bytes). */
  readonly hashPepper: Uint8Array;
  readonly adultUnlockTtlSeconds: number;
  readonly childAccessTtlSeconds: number;
  readonly childRefreshTtlSeconds: number;
  readonly pairingCodeTtlSeconds: number;
  /** Fixed program calendar zone for P17 donation months. */
  readonly programTimezone: string;
  readonly providers: {
    /**
     * Verifiable parental consent, selected explicitly (AC_DEPLOY_07):
     * - `development_mock`: the labeled mock, only ever in development and test;
     * - `unavailable`: staging/production without an adapter; nothing can be verified;
     * - `configured`: the implemented adapter named by `consentAdapter`.
     */
    readonly consent: 'development_mock' | 'unavailable' | 'configured';
    /** CONSENT_PROVIDER when `consent` is `configured`, otherwise null. */
    readonly consentAdapter: string | null;
    /**
     * Store subscription state, selected explicitly like consent (AC_DEPLOY_07):
     * - `development_mock`: the labeled subscriber-state mock, only in development and test;
     * - `unavailable`: staging/production without REVENUECAT_SECRET_API_KEY; every fetch fails, so
     *   nothing is granted or revoked from an empty mock state;
     * - `revenuecat`: the RevenueCat REST client.
     */
    readonly billing: 'development_mock' | 'unavailable' | 'revenuecat';
    /** Optional adult web billing client (Stripe, STRIPE_SECRET_KEY), same rule as `billing`. */
    readonly webBilling: 'development_mock' | 'unavailable' | 'stripe';
    readonly ai: 'development_mock' | 'openai';
    readonly storage: 'development_mock' | 'supabase';
    /** No transactional email adapter exists yet; invitations go to a development outbox. */
    readonly email: 'development_mock';
  };
  readonly flags: {
    /** Optional adult web billing (spec P11) — disabled until the owner decides launch policy. */
    readonly stripeWebBillingEnabled: boolean;
    /** School payout transfers — disabled until real recipient details exist (spec P17). */
    readonly payoutTransfersEnabled: boolean;
    /** Inactivity notice + deletion (spec P4) — off until the owner approves the period. */
    readonly inactivityDeletionEnabled: boolean;
  };
  /** Months without family activity before the inactivity notice (proposed 12). */
  readonly inactivityMonths: number;
  /** Days between the notice and deletion when nothing happens (proposed 30). */
  readonly inactivityNoticeDays: number;
  readonly zdrEvidence: ZdrEvidence | null;
  readonly corsOrigins: readonly string[];
  readonly webhooks: {
    /** RevenueCat sends this exact Authorization header value (configured in its dashboard). */
    readonly revenuecatAuthorization: string | null;
    /** Stripe endpoint signing secret (whsec_…). */
    readonly stripeSigningSecret: string | null;
  };
  /** Store environment whose purchases grant capacity here (sandbox purchases never grant production access). */
  readonly billingEnvironment: 'sandbox' | 'production';
}

export type ConfigError = { readonly name: string; readonly problem: string };

const encoder = new TextEncoder();

function secretBytes(
  env: Record<string, string | undefined>,
  name: string,
  errors: ConfigError[],
): Uint8Array {
  const value = env[name];
  if (!value || value.length < 32) {
    errors.push({ name, problem: 'required secret of at least 32 characters' });
    return new Uint8Array(32);
  }
  return encoder.encode(value);
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  errors: ConfigError[],
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push({ name, problem: 'must be a positive integer' });
    return fallback;
  }
  return value;
}

export function loadConfig(
  env: Record<string, string | undefined>,
): { ok: true; config: ApiConfig } | { ok: false; errors: ConfigError[] } {
  const errors: ConfigError[] = [];
  const environment = (env.APP_ENV ?? 'development') as Environment;
  if (!['development', 'test', 'staging', 'production'].includes(environment)) {
    errors.push({ name: 'APP_ENV', problem: 'must be development, test, staging or production' });
  }
  const jwksUrl = env.SUPABASE_JWKS_URL ?? null;
  const jwtSecret = env.SUPABASE_JWT_SECRET ? encoder.encode(env.SUPABASE_JWT_SECRET) : null;
  if (!jwksUrl && !jwtSecret) {
    errors.push({
      name: 'SUPABASE_JWKS_URL',
      problem: 'set SUPABASE_JWKS_URL (or SUPABASE_JWT_SECRET locally)',
    });
  }
  const jwtIssuer = env.SUPABASE_JWT_ISSUER ?? '';
  if (!jwtIssuer) errors.push({ name: 'SUPABASE_JWT_ISSUER', problem: 'required' });

  const programTimezone = env.PROGRAM_TIMEZONE ?? 'UTC';
  if (!isValidIanaZone(programTimezone)) {
    errors.push({ name: 'PROGRAM_TIMEZONE', problem: 'must be a valid IANA zone' });
  }

  const zdrEvidence =
    env.ZDR_APPROVAL_EVIDENCE_REFERENCE && env.ZDR_APPROVAL_VERIFIED_AT
      ? { reference: env.ZDR_APPROVAL_EVIDENCE_REFERENCE, verifiedAt: env.ZDR_APPROVAL_VERIFIED_AT }
      : null;

  const config: ApiConfig = {
    environment,
    supabase: { jwtIssuer, jwksUrl, jwtSecret },
    childTokenSecret: secretBytes(env, 'CHILD_TOKEN_SECRET', errors),
    hashPepper: secretBytes(env, 'HASH_PEPPER', errors),
    adultUnlockTtlSeconds: positiveInt(env, 'ADULT_UNLOCK_TTL_SECONDS', 300, errors),
    childAccessTtlSeconds: positiveInt(env, 'CHILD_ACCESS_TTL_SECONDS', 900, errors),
    childRefreshTtlSeconds: positiveInt(env, 'CHILD_REFRESH_TTL_SECONDS', 30 * 24 * 3600, errors),
    pairingCodeTtlSeconds: positiveInt(env, 'PAIRING_CODE_TTL_SECONDS', 600, errors),
    programTimezone,
    providers: {
      // No real consent adapter is implemented yet, so nothing can mark consent as configured;
      // naming an unknown provider is a configuration error rather than a silent mock.
      ...consentProvider(env.CONSENT_PROVIDER, environment, errors),
      billing: env.REVENUECAT_SECRET_API_KEY ? 'revenuecat' : mockOrUnavailable(environment),
      webBilling: env.STRIPE_SECRET_KEY ? 'stripe' : mockOrUnavailable(environment),
      ai: env.OPENAI_API_KEY ? 'openai' : 'development_mock',
      storage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'development_mock',
      email: 'development_mock',
    },
    flags: {
      stripeWebBillingEnabled: env.OPTIONAL_STRIPE_WEB_BILLING_ENABLED === 'true',
      payoutTransfersEnabled: env.PAYOUT_TRANSFERS_ENABLED === 'true',
      inactivityDeletionEnabled: env.INACTIVITY_DELETION_ENABLED === 'true',
    },
    inactivityMonths: positiveInt(env, 'INACTIVITY_MONTHS', 12, errors),
    inactivityNoticeDays: positiveInt(env, 'INACTIVITY_NOTICE_DAYS', 30, errors),
    zdrEvidence,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    webhooks: {
      revenuecatAuthorization: env.REVENUECAT_WEBHOOK_AUTH ?? null,
      stripeSigningSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    },
    billingEnvironment: environment === 'production' ? 'production' : 'sandbox',
  };
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

/**
 * Consent adapters implemented in this codebase (none yet: owner action #7 selects the provider).
 * Each name must also have a factory in the Worker (src/index.ts CONSENT_ADAPTER_FACTORIES);
 * tests/runtime.test.ts keeps the two lists equal.
 */
export const CONSENT_ADAPTERS: ReadonlySet<string> = new Set<string>();

/** Environments where labeled development mocks may be wired (never staging or production). */
export const MOCK_ENVIRONMENTS: ReadonlySet<Environment> = new Set<Environment>([
  'development',
  'test',
]);

/** Without credentials: the labeled mock in development/test, no provider anywhere else. */
function mockOrUnavailable(environment: Environment): 'development_mock' | 'unavailable' {
  return MOCK_ENVIRONMENTS.has(environment) ? 'development_mock' : 'unavailable';
}

function consentProvider(
  value: string | undefined,
  environment: Environment,
  errors: ConfigError[],
): Pick<ApiConfig['providers'], 'consent' | 'consentAdapter'> {
  if (value) {
    if (CONSENT_ADAPTERS.has(value)) return { consent: 'configured', consentAdapter: value };
    errors.push({ name: 'CONSENT_PROVIDER', problem: `no adapter is implemented for "${value}"` });
    return { consent: 'unavailable', consentAdapter: null };
  }
  return MOCK_ENVIRONMENTS.has(environment)
    ? { consent: 'development_mock', consentAdapter: null }
    : { consent: 'unavailable', consentAdapter: null };
}

export interface ReadinessItem {
  readonly check: string;
  readonly status: 'ready' | 'blocked';
  readonly detail: string;
}

/** Facts the readiness report needs beyond configuration. */
export interface ReadinessFacts {
  /** The instant being reported on (the ZDR verification date may not be after it). */
  readonly now: Date;
  /**
   * Whether the owner has set the global AI spend cap for `now`'s UTC month (spec F4: the cap is
   * never invented). Unknown (not looked up) reads as blocked.
   */
  readonly spendBudgetForCurrentMonth?: boolean;
  /**
   * Live fixture or fake rows per catalog (reviewed resources, store product and ad-free mappings,
   * provider offers, affiliate/sponsor approvals, sponsors and sponsor campaigns), as defined by
   * migration 0770 app.fake_catalog_rows(). Unknown (not looked up) reads as blocked.
   */
  readonly fakeCatalogRows?: Readonly<Record<string, number>>;
  /**
   * The environment the database itself is marked as (private.deployment), or null when it was never
   * marked. Only a database marked production refuses fixture and fake catalog rows.
   */
  readonly databaseEnvironment?: Environment | null;
}

/** UTC calendar month key used by public.spend_budgets.period_key, e.g. "2026-09". */
export function utcPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Looks up the database facts for the owner readiness report. */
export async function loadReadinessFacts(db: Db, now: Date): Promise<ReadinessFacts> {
  return db.asService(async (tx) => {
    const [row] = await tx<{ present: boolean; database_environment: Environment | null }[]>`
      select exists (
        select 1 from public.spend_budgets
         where scope = 'global' and period_key = ${utcPeriodKey(now)}
      ) as present, app.database_environment() as database_environment
    `;
    const catalogs = await tx<{ catalog: string; fake_rows: number }[]>`
      select catalog, fake_rows from app.fake_catalog_rows()
    `;
    return {
      now,
      spendBudgetForCurrentMonth: row?.present === true,
      fakeCatalogRows: Object.fromEntries(catalogs.map((c) => [c.catalog, c.fake_rows])),
      databaseEnvironment: row?.database_environment ?? null,
    };
  });
}

function catalogDataItem(facts: ReadinessFacts): { ok: boolean; detail: string } {
  const base =
    'No live fixture or fake catalog rows (reviewed resources, store product and ad-free mappings, provider offers, affiliate/sponsor approvals, sponsors and sponsor campaigns)';
  if (facts.fakeCatalogRows === undefined) return { ok: false, detail: `${base}; not checked` };
  const found = Object.entries(facts.fakeCatalogRows)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (found.length === 0) return { ok: true, detail: base };
  const counts = found.map(([catalog, n]) => `${catalog} ${n}`).join(', ');
  return {
    ok: false,
    detail: `${base}; found ${counts} (retire, revoke, deactivate, suspend or end them)`,
  };
}

/** AC_DEPLOY_07 / AC_RELEASE_02: what would block serving real families. */
export function productionReadiness(
  config: ApiConfig,
  facts: ReadinessFacts = { now: new Date() },
): ReadinessItem[] {
  const item = (check: string, ok: boolean, detail: string): ReadinessItem => ({
    check,
    status: ok ? 'ready' : 'blocked',
    detail,
  });
  const catalog = catalogDataItem(facts);
  return [
    item(
      'consent_provider',
      config.providers.consent === 'configured',
      'Verifiable parental consent provider (mock is development-only)',
    ),
    item(
      'billing_provider',
      config.providers.billing === 'revenuecat',
      'RevenueCat server credentials (mock billing is development-only; without them no purchase can be verified)',
    ),
    item(
      'web_billing_provider',
      !config.flags.stripeWebBillingEnabled || config.providers.webBilling === 'stripe',
      'Stripe server credentials when optional adult web billing is enabled (mock is development-only)',
    ),
    item(
      'ai_provider',
      config.providers.ai === 'openai',
      'OpenAI server credentials (mock AI is development-only)',
    ),
    item(
      'zdr_evidence',
      // The same validation the enforcing child-data gate applies (packages/ai checkChildDataGate).
      validateZdrEvidence(config.zdrEvidence, facts.now).ok,
      'Documented ZDR approval reference and a past verification date required before under-13 data reaches AI',
    ),
    item(
      'ai_spend_budget',
      facts.spendBudgetForCurrentMonth === true,
      `Owner-set AI spend cap for ${utcPeriodKey(facts.now)} (UTC); set each month's cap before it starts`,
    ),
    item('catalog_data', catalog.ok, catalog.detail),
    item(
      'database_environment',
      facts.databaseEnvironment === 'production',
      `Database marked production (private.deployment), so it refuses fixture and fake catalog rows; ${
        facts.databaseEnvironment === undefined
          ? 'not checked'
          : `currently ${facts.databaseEnvironment ?? 'unmarked'}`
      }`,
    ),
    item(
      'storage_provider',
      config.providers.storage === 'supabase',
      'Private homework storage (Supabase Storage); the in-memory mock loses files',
    ),
    item(
      'email_provider',
      false,
      'Transactional email adapter not implemented; outside development/test invitations and notices cannot be sent',
    ),
    item(
      'safety_templates',
      SAFETY_TEMPLATES_APPROVED,
      `Child safety messages and parent wording (${SAFETY_TEMPLATES_STATUS}), the family-hold default and the runbook 5.1 escalation steps need owner, educator and counsel approval`,
    ),
    item(
      'ai_moderation',
      false,
      'Provider moderation (OpenAI moderation endpoint) before and after generation is not wired; only the deterministic first-layer safety screen runs',
    ),
    item(
      'parent_jwt_keys',
      config.supabase.jwksUrl !== null,
      'Supabase JWKS (asymmetric) keys; HS256 secret is local-only',
    ),
    item(
      'cors',
      config.corsOrigins.length > 0 && !config.corsOrigins.includes('*'),
      'Explicit CORS origins',
    ),
  ];
}

export function isProductionReady(config: ApiConfig, facts?: ReadinessFacts): boolean {
  return productionReadiness(config, facts).every((r) => r.status === 'ready');
}

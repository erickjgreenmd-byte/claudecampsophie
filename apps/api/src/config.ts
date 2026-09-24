import { isValidIanaZone } from '@pencillift/domain';

/**
 * Runtime configuration. Only names appear in source; values come from Worker secrets/vars.
 * `productionReadiness()` is the AC_DEPLOY_07 gate: production refuses to serve with mock consent,
 * mock billing, mock AI, missing ZDR evidence or missing secrets.
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
    readonly consent: 'development_mock' | 'configured';
    readonly billing: 'development_mock' | 'revenuecat';
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
  };
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
      consent: consentProvider(env.CONSENT_PROVIDER, errors),
      billing: env.REVENUECAT_SECRET_API_KEY ? 'revenuecat' : 'development_mock',
      ai: env.OPENAI_API_KEY ? 'openai' : 'development_mock',
      storage: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'development_mock',
      email: 'development_mock',
    },
    flags: {
      stripeWebBillingEnabled: env.OPTIONAL_STRIPE_WEB_BILLING_ENABLED === 'true',
      payoutTransfersEnabled: env.PAYOUT_TRANSFERS_ENABLED === 'true',
    },
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

/** Consent adapters implemented in this codebase (none yet: owner action #7 selects the provider). */
const CONSENT_ADAPTERS: ReadonlySet<string> = new Set<string>();

function consentProvider(
  value: string | undefined,
  errors: ConfigError[],
): 'development_mock' | 'configured' {
  if (!value) return 'development_mock';
  if (CONSENT_ADAPTERS.has(value)) return 'configured';
  errors.push({ name: 'CONSENT_PROVIDER', problem: `no adapter is implemented for "${value}"` });
  return 'development_mock';
}

export interface ReadinessItem {
  readonly check: string;
  readonly status: 'ready' | 'blocked';
  readonly detail: string;
}

/** AC_DEPLOY_07 / AC_RELEASE_02: what would block serving real families. */
export function productionReadiness(config: ApiConfig): ReadinessItem[] {
  const item = (check: string, ok: boolean, detail: string): ReadinessItem => ({
    check,
    status: ok ? 'ready' : 'blocked',
    detail,
  });
  return [
    item(
      'consent_provider',
      config.providers.consent === 'configured',
      'Verifiable parental consent provider (mock is development-only)',
    ),
    item(
      'billing_provider',
      config.providers.billing === 'revenuecat',
      'RevenueCat server credentials (mock billing is development-only)',
    ),
    item(
      'ai_provider',
      config.providers.ai === 'openai',
      'OpenAI server credentials (mock AI is development-only)',
    ),
    item(
      'zdr_evidence',
      config.zdrEvidence !== null,
      'Documented ZDR approval reference required before under-13 data reaches AI',
    ),
    item(
      'storage_provider',
      config.providers.storage === 'supabase',
      'Private homework storage (Supabase Storage); the in-memory mock loses files',
    ),
    item(
      'email_provider',
      false,
      'Transactional email adapter not implemented; guardian invitations use a development outbox',
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

export function isProductionReady(config: ApiConfig): boolean {
  return productionReadiness(config).every((r) => r.status === 'ready');
}

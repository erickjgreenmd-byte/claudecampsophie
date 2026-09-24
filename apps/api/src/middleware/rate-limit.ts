import type { Db } from '../db.ts';
import { ApiError } from '../errors.ts';

export interface RateRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimiter {
  hit(
    key: string,
    rule: RateRule,
    now: Date,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

/** Postgres-backed fixed-window limiter shared by every Worker instance (migration 0610). */
export function createDbRateLimiter(db: Db): RateLimiter {
  return {
    async hit(key, rule, now) {
      const [row] = await db.asService(
        (tx) => tx<{ allowed: boolean; retry_after_seconds: number }[]>`
          select allowed, retry_after_seconds from app.rate_limit_hit(${key}, ${rule.limit}, ${rule.windowSeconds}, ${now})
        `,
      );
      return {
        allowed: row?.allowed ?? false,
        retryAfterSeconds: row?.retry_after_seconds ?? rule.windowSeconds,
      };
    },
  };
}

export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  rule: RateRule,
  now: Date,
): Promise<void> {
  const result = await limiter.hit(key, rule, now);
  if (!result.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', {
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
}

/** Named rules so limits are reviewed in one place. */
export const RATE_RULES = {
  pinAttemptPerSession: { limit: 10, windowSeconds: 15 * 60 },
  pinResetPerUser: { limit: 5, windowSeconds: 24 * 3600 },
  pairingRedeemPerIp: { limit: 20, windowSeconds: 15 * 60 },
  pairingCreatePerFamily: { limit: 20, windowSeconds: 3600 },
  childRefreshPerSession: { limit: 60, windowSeconds: 3600 },
  promoQuotePerUser: { limit: 20, windowSeconds: 3600 },
  promoRedeemPerFamily: { limit: 10, windowSeconds: 3600 },
  promoInvalidCodePerFamily: { limit: 8, windowSeconds: 24 * 3600 },
} as const satisfies Record<string, RateRule>;

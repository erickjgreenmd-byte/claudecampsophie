import type { Db } from '../db.ts';
import { ApiError } from '../errors.ts';

export interface RateRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/** Outcome of reserving one unit of a shared failure budget (see RateLimiter.reserveShared). */
export interface SharedBudgetReservation {
  /** The attempt may run. */
  readonly allowed: boolean;
  /** The shared budget is used up (alert); `allowed` then means this client's one attempt. */
  readonly exhausted: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit against `key` and reports whether it is within the rule. */
  hit(key: string, rule: RateRule, now: Date): Promise<RateLimitResult>;
  /**
   * Reserves one unit of a failure budget shared by every client, and one of `clientKey`, before
   * the attempt runs, so attempts in flight count (AC_SECURITY_06). While the shared budget lasts
   * every attempt may run. Once it is used up, a client with no failure and no attempt in flight in
   * the window may still make one attempt; other clients are refused and keep nothing. A successful
   * attempt gives both units back with `release`; a failed one keeps them.
   */
  reserveShared(
    sharedKey: string,
    clientKey: string,
    rule: RateRule,
    now: Date,
  ): Promise<SharedBudgetReservation>;
  /** Gives back one unit of `key` in the window of `now` (never below zero). */
  release(key: string, rule: RateRule, now: Date): Promise<void>;
}

/** Postgres-backed fixed-window limiter shared by every Worker instance (migrations 0610, 0720). */
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
    async reserveShared(sharedKey, clientKey, rule, now) {
      const [row] = await db.asService(
        (tx) => tx<{ allowed: boolean; exhausted: boolean; retry_after_seconds: number }[]>`
          select allowed, exhausted, retry_after_seconds
            from app.rate_limit_reserve_shared(${sharedKey}, ${clientKey}, ${rule.limit}, ${rule.windowSeconds}, ${now})
        `,
      );
      return {
        allowed: row?.allowed ?? false,
        exhausted: row?.exhausted ?? true,
        retryAfterSeconds: row?.retry_after_seconds ?? rule.windowSeconds,
      };
    },
    async release(key, rule, now) {
      await db.asService(
        (tx) => tx`select app.rate_limit_release(${key}, ${rule.windowSeconds}, ${now})`,
      );
    },
  };
}

/** The 429 every limiter refusal answers with; Retry-After is the rest of the window in seconds. */
export function rateLimitedError(retryAfterSeconds: number): ApiError {
  return new ApiError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', {
    retryAfterSeconds,
  });
}

export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  rule: RateRule,
  now: Date,
): Promise<void> {
  const result = await limiter.hit(key, rule, now);
  if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
}

/** Named rules so limits are reviewed in one place. */
export const RATE_RULES = {
  pinAttemptPerSession: { limit: 10, windowSeconds: 15 * 60 },
  /** Across all of an adult's sessions (a lockout still engages after 5 wrong PINs). */
  pinAttemptPerUser: { limit: 20, windowSeconds: 15 * 60 },
  pinResetPerUser: { limit: 5, windowSeconds: 24 * 3600 },
  /**
   * Setting or changing the PIN, per adult (API-AUTH-R1-04 follow-up): each call hashes with PBKDF2
   * and the first-time set needs only a session, so a stolen session cannot burn CPU or churn the
   * PIN at will. Counted only for calls that would replace the PIN (after the weak-PIN and step-up
   * checks), so refused calls cannot use up the parent's own budget.
   */
  pinSetPerUser: { limit: 10, windowSeconds: 3600 },
  /** Per client network: an IPv4 address or an IPv6 /64 (one subscriber's allocation). */
  pairingRedeemPerNetwork: { limit: 20, windowSeconds: 15 * 60 },
  /**
   * Failed code redemptions across the whole service, reserved before each guess runs. 40-bit codes
   * live 10 minutes, so this bounds a distributed guesser's odds. Once it is used up, each site
   * (IPv4 /24, IPv6 /48) with no failed or running guess in the hour gets one attempt and every
   * other site waits for the next hour, so a guesser pauses their own sites, not every family's
   * pairing. Exhaustion logs `pairing_failure_budget_exhausted` at error level for alerting.
   */
  pairingRedeemFailuresGlobal: { limit: 200, windowSeconds: 3600 },
  pairingCreatePerFamily: { limit: 20, windowSeconds: 3600 },
  childRefreshPerSession: { limit: 60, windowSeconds: 3600 },
  /**
   * Refreshes per client network before the token lookup (API-AUTH-R1-04): a script cannot use the
   * database to test tokens at will. A family's four paired devices refresh ~4 times an hour each.
   */
  childRefreshPerNetwork: { limit: 240, windowSeconds: 3600 },
  /**
   * Parent create routes, per family (API-AUTH-R1-04; spec: every endpoint defines a limit). Abuse
   * bounds well above real use, so a stuck button or a script cannot bloat the family's views.
   */
  childCreatePerFamily: { limit: 12, windowSeconds: 24 * 3600 },
  rewardCreatePerFamily: { limit: 40, windowSeconds: 3600 },
  subjectCreatePerFamily: { limit: 20, windowSeconds: 3600 },
  testDateCreatePerFamily: { limit: 30, windowSeconds: 3600 },
  studyMaterialCreatePerFamily: { limit: 30, windowSeconds: 3600 },
  scheduleUpdatePerFamily: { limit: 30, windowSeconds: 3600 },
  promoQuotePerUser: { limit: 20, windowSeconds: 3600 },
  promoRedeemPerFamily: { limit: 10, windowSeconds: 3600 },
  promoInvalidCodePerFamily: { limit: 8, windowSeconds: 24 * 3600 },
} as const satisfies Record<string, RateRule>;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(text: string): number[] | null {
  const m = IPV4_RE.exec(text);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Expands an IPv6 address to its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let address = text.toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(address) || !address.includes(':')) return null;
  // A trailing dotted quad (e.g. ::ffff:192.0.2.1) is two groups.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Octets(tail);
    if (!v4) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    address = `${address.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

type ClientAddress =
  | { readonly kind: 'v4'; readonly octets: readonly number[] }
  | { readonly kind: 'v6'; readonly groups: readonly number[] };

/** Parses a client address; IPv4-mapped IPv6 addresses count as their IPv4 address. */
function parseClientAddress(address: string | undefined | null): ClientAddress | null {
  const text = (address ?? '').trim();
  const octets = ipv4Octets(text);
  if (octets) return { kind: 'v4', octets };
  const groups = ipv6Groups(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return { kind: 'v4', octets: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff] };
  }
  return { kind: 'v6', groups };
}

const hexGroups = (groups: readonly number[], count: number) =>
  groups
    .slice(0, count)
    .map((g) => g.toString(16))
    .join(':');

/**
 * Rate-limit identity of a client address: the address for IPv4 and the /64 prefix for IPv6 (one
 * subscriber routinely controls a whole /64, so per-address limits there are no limit at all).
 * IPv4-mapped IPv6 addresses count as their IPv4 address. Unparseable input shares one bucket.
 */
export function clientNetworkKey(address: string | undefined | null): string {
  const parsed = parseClientAddress(address);
  if (!parsed) return 'unknown';
  return parsed.kind === 'v4'
    ? `v4:${parsed.octets.join('.')}`
    : `v6:${hexGroups(parsed.groups, 4)}::/64`;
}

/**
 * The site a client address belongs to, for pausing a guesser once a shared failure budget is used
 * up: the IPv4 /24 or the IPv6 /48 (a typical site allocation, 65,536 /64s). Coarser than
 * clientNetworkKey so that rotating addresses or /64s inside one allocation does not look like
 * many clean clients. Unparseable input shares one bucket.
 */
export function clientSiteKey(address: string | undefined | null): string {
  const parsed = parseClientAddress(address);
  if (!parsed) return 'unknown';
  return parsed.kind === 'v4'
    ? `v4:${parsed.octets.slice(0, 3).join('.')}.0/24`
    : `v6:${hexGroups(parsed.groups, 3)}::/48`;
}

/**
 * Deletes rate-limit buckets whose window has ended (for the scheduled tick). Every hit also
 * clears a few buckets that ended over a day ago (migration 0720), so the table stays bounded
 * without this; the tick only clears a backlog sooner.
 */
export async function purgeExpiredRateLimitBuckets(db: Db, now: Date): Promise<number> {
  const [row] = await db.asService(
    (tx) =>
      tx<{ removed: number }[]>`select app.purge_expired_rate_limit_buckets(${now}) as removed`,
  );
  return row?.removed ?? 0;
}

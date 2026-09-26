import {
  childTokenResponseSchema,
  familyOkResponseSchema,
  uuidSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient, type TokenSource } from '@pencillift/contracts/client';
import { STORAGE_KEYS, unpairChildDevice, type SecureStorage } from '../lib/mode.ts';
import { pairingErrorMessage, validatePairingCode } from './pairing-code.ts';

/**
 * The paired child's session on this device (spec P3, AC_ACCESS_04/08). Pure: no react-native.
 *
 * - Pairing redeems a parent-issued one-time code for a child-scoped session only.
 * - The rotating refresh token lives in the device keychain (SecureStorage); the short-lived access
 *   token lives only in memory.
 * - Refresh is single-flight: two concurrent requests never present the same refresh token twice,
 *   which the server treats as theft and answers by revoking the session.
 * - When the server says the session is gone (device disconnected, logout, deletion), the device
 *   forgets the child: refresh token and cached profile are removed.
 */

/** The stored profile has exactly the shape the pairing response returned (strict schema). */
const childProfileSchema = childTokenResponseSchema.shape.child;

export interface ChildProfile {
  readonly id: string;
  readonly nickname: string;
}

type ChildTokenResponse = ReturnType<typeof childTokenResponseSchema.parse>;

/** Refresh this long before expiry so a request never starts with an about-to-expire token. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * How long a request id found in secure storage may still be adopted, measured on this device's own
 * clock from the instant this device minted it.
 *
 * It mirrors RECOVERY_WINDOW_MS in apps/api/src/routes/child-auth.ts (two minutes after the rotation
 * the id consumed), and is deliberately far longer, because the two ends measure it on different
 * clocks and this one is not the server's (L-038): a device clock nudged forward by NTP, or a cold
 * start that takes its time, must not make the device throw away an id the server would still honour.
 * The slack only ever ADMITS an id, and an admitted id the server has finished with is refused
 * exactly as a fresh one would be.
 *
 * Past it, the stored id belongs to an attempt the server can no longer serve a recovery for, so
 * presenting it buys nothing and costs the rule the whole mechanism rests on — one id per logical
 * attempt (L-049). A fresh one is minted instead. That also ends the id that used to be presented on
 * every later refresh of the device's life when the deleteItem in refreshFinished() failed and the
 * failure was swallowed.
 */
const REQUEST_ID_MAX_AGE_MS = 10 * 60_000;

/** The unfinished refresh as secure storage holds it: the id, and when this device minted it. */
interface PendingRequest {
  readonly id: string;
  readonly mintedAtMs: number;
}

/**
 * Reads the stored record back. Anything this device cannot vouch for — junk, an older build's bare
 * id, a record with no readable mint instant — is no record at all, so the caller mints instead of
 * presenting an id whose age is unknown.
 */
function parseStoredRequest(raw: string | null): PendingRequest | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { id, mintedAtMs } = value as { id?: unknown; mintedAtMs?: unknown };
  // A stored id that is not a uuid would be refused by the contract on every attempt, which would
  // wedge this device out of refreshing entirely.
  if (typeof id !== 'string' || !uuidSchema.safeParse(id).success) return null;
  if (typeof mintedAtMs !== 'number' || !Number.isFinite(mintedAtMs)) return null;
  return { id, mintedAtMs };
}

export interface ChildSessionDeps {
  readonly storage: SecureStorage;
  /** Unauthenticated client (pairing and refresh carry their own credentials in the body). */
  readonly publicApi: ApiClient;
  /** Builds a client that sends the given bearer token (used for logout). */
  readonly authedApi: (token: TokenSource) => ApiClient;
  readonly now: () => Date;
  /**
   * One id per refresh, so the server can tell this device's own retry of a refresh from a replay of
   * a stolen token (BUG-244). Required and injected rather than imported: expo-crypto reaches into
   * react-native, which this module's vitest project cannot parse, and this module stays testable
   * without it. The app passes expo-crypto's randomUUID (src/family/runtime.ts).
   */
  readonly newRequestId: () => string;
}

export type PairResult =
  | { readonly ok: true; readonly child: ChildProfile }
  | { readonly ok: false; readonly message: string };

export interface ChildSession {
  pair(input: {
    code: string;
    deviceLabel: string;
    platform: 'ios' | 'android' | 'web';
  }): Promise<PairResult>;
  /** Bearer token source for child API calls; null when this device is not paired. */
  readonly accessToken: TokenSource;
  profile(): Promise<ChildProfile | null>;
  isPaired(): Promise<boolean>;
  /**
   * Drops the cached access token so the next `accessToken()` goes through the one single-flight
   * refresh (MOB-R2-02). Returns true when there was a cached token to drop, so a caller can tell a
   * token the server refused from a call that had no token at all.
   */
  invalidateAccessToken(): boolean;
  /**
   * Counts every change to the cached access token (a refresh that stored one, a drop, a forget).
   * A caller that read it before making a call can tell "the token I presented is still the current
   * one" from "the token has already moved on since" without holding the token itself (HUNT4-MOB-3).
   */
  accessTokenGeneration(): number;
  /** Ends the session on the server (best effort) and forgets the child on this device. */
  logout(): Promise<void>;
}

/**
 * Wraps a child API client so that one UNAUTHENTICATED answer to a data call, while a cached access
 * token was presented, drops that token and retries the call once (MOB-R2-02). The retry goes
 * through the session's existing single-flight refresher — never a second one (L-007) — so the
 * device recovers from a token the server has already expired (a wrong device clock, a token issued
 * before a clock change) instead of telling the child the device is not connected. A refusal with no
 * cached token, or a second refusal after a fresh one, is passed on unchanged: only the refresh
 * itself being refused forgets the pairing.
 *
 * The one retry belongs to the CALL, not to the session (HUNT4-MOB-3). Deciding by "is a token
 * cached right now" gave the whole session a single slot: of two calls that presented the same stale
 * token, the first refusal to land dropped the token and retried, and the second found nothing
 * cached and was told the device is not connected — while the refresh it needed was already in
 * flight. So each call notes the token generation it started on: a refusal after the generation
 * moved on is retried against the newer token without dropping it, which keeps the single-flight
 * refresher to one rotation however many calls were refused together.
 */
export function withChildTokenRetry(
  api: ApiClient,
  session: Pick<ChildSession, 'accessToken' | 'invalidateAccessToken' | 'accessTokenGeneration'>,
): ApiClient {
  const once = async <T>(run: () => Promise<T>): Promise<T> => {
    // The token for this call is resolved FIRST, so the generation below is the one the call will
    // actually present (HUNT5-G-3). The bearer is fetched inside the request, and resolving it can
    // rotate the token: a call whose cached token had expired on the device's own clock refreshed
    // for itself, which moved the generation, so its refusal read as "another call replaced the
    // token I presented" and retried the SAME token — the drop this wrapper exists for never ran.
    // Resolving it here is free: the session caches the token and joins its one single-flight
    // refresh, so the request's own fetch finds it ready.
    await session.accessToken();
    const generation = session.accessTokenGeneration();
    try {
      return await run();
    } catch (error) {
      const refused = error instanceof ApiRequestError && error.code === 'UNAUTHENTICATED';
      if (!refused) throw error;
      // Another call already dropped or replaced the token this one presented: retry on the new one.
      if (session.accessTokenGeneration() !== generation) return run();
      if (!session.invalidateAccessToken()) throw error;
      return run();
    }
  };
  return {
    get: (path, schema, options) => once(() => api.get(path, schema, options)),
    send: (method, path, body, schema, options) =>
      once(() => api.send(method, path, body, schema, options)),
  };
}

export function createChildSession(deps: ChildSessionDeps): ChildSession {
  let access: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string | null> | null = null;
  /**
   * The refresh this device is still trying to finish (BUG-244); null between refreshes. Mirrored in
   * secure storage, so an app the OS kills mid-refresh still finishes that refresh.
   */
  let pendingRequest: PendingRequest | null = null;
  const newRequestId = deps.newRequestId;
  /** Bumped on every change to `access`, so a caller can tell a token apart from its successor. */
  let generation = 0;

  async function persist(response: ChildTokenResponse, receivedAt: Date): Promise<void> {
    // Store the rotated refresh token before anything else uses the new access token.
    await deps.storage.setItem(STORAGE_KEYS.childRefreshToken, response.refreshToken);
    await deps.storage.setItem(STORAGE_KEYS.childProfile, JSON.stringify(response.child));
    // The expiry is measured on THIS device's clock (MOB-R2-02): the device's own time when the
    // token arrived plus the lifetime the server stated. `accessTokenExpiresAt` is a server instant,
    // and comparing it with a device clock that is minutes off either presents a token the server
    // has already rejected (slow clock: the child is told the device isn't connected) or treats every
    // token as expired (fast clock: a refresh per call, which exhausts the server's refresh limit).
    access = {
      token: response.accessToken,
      expiresAtMs: receivedAt.getTime() + response.accessTokenExpiresInSeconds * 1000,
    };
    generation += 1;
  }

  async function forget(): Promise<void> {
    access = null;
    generation += 1;
    // The unfinished refresh dies with the session it belonged to (HUNT5-G-1). Leaving it in memory
    // let a LATER session's first refresh present a dead session's id — and skip the write below,
    // because the id was only stored when it was minted — so an app killed mid-refresh came back,
    // found nothing stored, minted a new id and presented an already-rotated token under it, which
    // the server reads as theft.
    pendingRequest = null;
    await unpairChildDevice(deps.storage);
  }

  /** The id of the attempt in flight, minted once and then read back from storage on every retry. */
  async function requestIdForThisRefresh(nowMs: number): Promise<string> {
    if (pendingRequest === null) {
      const stored = parseStoredRequest(
        await deps.storage.getItem(STORAGE_KEYS.childRefreshRequestId).catch(() => null),
      );
      // An id this device minted longer ago than REQUEST_ID_MAX_AGE_MS is an id from an attempt the
      // server has finished with, so this refresh is a new attempt and takes a new id. A mint
      // instant in the future (a clock moved back) reads as young, which is the side to err on: the
      // slack exists to keep a recoverable id, never to discard one.
      pendingRequest =
        stored !== null && nowMs - stored.mintedAtMs <= REQUEST_ID_MAX_AGE_MS
          ? stored
          : { id: newRequestId(), mintedAtMs: nowMs };
    }
    // Written on EVERY path, not only when the id is minted (HUNT5-G-1): the invariant this refresh
    // depends on is that the id is in storage before the request goes out, and a refresh that
    // carries an id already in memory has to hold it too — a first write the keychain refused, and a
    // retry that then skipped the write, left the id in memory alone. One record, so the id and its
    // mint instant can never be stored apart; the instant is the MINT's, not this write's, or an id
    // rewritten on every retry would never age.
    await deps.storage
      .setItem(STORAGE_KEYS.childRefreshRequestId, JSON.stringify(pendingRequest))
      .catch(() => undefined);
    return pendingRequest.id;
  }

  /** This refresh is over, whichever way it ended: the next one is a new attempt with a new id. */
  async function refreshFinished(): Promise<void> {
    pendingRequest = null;
    await deps.storage.deleteItem(STORAGE_KEYS.childRefreshRequestId).catch(() => undefined);
  }

  async function refresh(): Promise<string | null> {
    const refreshToken = await deps.storage.getItem(STORAGE_KEYS.childRefreshToken);
    if (!refreshToken) return null;
    // BUG-244: one id per refresh, KEPT across this device's own retries of that refresh. The server
    // commits the rotation before its response goes out, so a response lost on the way back leaves
    // this device holding a token the server has marked used; presenting it again with the id that
    // consumed it is how the server recognises the rightful holder finishing its attempt instead of a
    // replay. A new id on the retry would be a new refresh, and would be treated as theft — so the id
    // is only cleared when this refresh actually finished, either with tokens or with a refusal.
    // The id is written BEFORE the request goes out, so it survives the process that sent it.
    const refreshRequestId = await requestIdForThisRefresh(deps.now().getTime());
    try {
      const response = await deps.publicApi.send(
        'POST',
        '/v1/child/refresh',
        { refreshToken, refreshRequestId },
        childTokenResponseSchema,
      );
      // The device's clock at the moment the response arrived, not before the request went out.
      await persist(response, deps.now());
      // Cleared only once the rotated token is stored: a process death in between must leave the id
      // in place, or the next attempt would present the old token under a NEW id — which is theft.
      await refreshFinished();
      return response.accessToken;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'UNAUTHENTICATED') {
        await refreshFinished();
        await forget();
        return null;
      }
      // Offline or server trouble: keep the refresh token AND the id, so the next attempt is the same
      // refresh rather than a new one, and the server can serve it if this response was the lost one.
      throw error;
    }
  }

  const accessToken: TokenSource = () => {
    if (access && access.expiresAtMs - EXPIRY_SKEW_MS > deps.now().getTime()) {
      return Promise.resolve(access.token);
    }
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    async pair(input) {
      const check = validatePairingCode(input.code);
      if (!check.ok) return { ok: false, message: check.message };
      try {
        const response = await deps.publicApi.send(
          'POST',
          '/v1/child/pair',
          {
            code: check.code,
            deviceLabel: input.deviceLabel.trim().slice(0, 60) || 'Child device',
            platform: input.platform,
          },
          childTokenResponseSchema,
        );
        await persist(response, deps.now());
        // A new session starts with no refresh of its own in flight: an id left by the session this
        // pairing replaces must never be presented for this one's token (HUNT5-G-1).
        await refreshFinished();
        return { ok: true, child: response.child };
      } catch (error) {
        return { ok: false, message: pairingErrorMessage(error) };
      }
    },

    accessToken,

    async profile() {
      const raw = await deps.storage.getItem(STORAGE_KEYS.childProfile);
      if (!raw) return null;
      try {
        const parsed = childProfileSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async isPaired() {
      return (await deps.storage.getItem(STORAGE_KEYS.childRefreshToken)) !== null;
    },

    invalidateAccessToken() {
      if (access === null) return false;
      access = null;
      generation += 1;
      return true;
    },

    accessTokenGeneration() {
      return generation;
    },

    async logout() {
      try {
        const token = await accessToken();
        if (token) {
          await deps
            .authedApi(() => Promise.resolve(token))
            .send('POST', '/v1/child/logout', undefined, familyOkResponseSchema);
        }
      } catch {
        // Best effort: the device forgets the child either way.
      }
      await forget();
    },
  };
}

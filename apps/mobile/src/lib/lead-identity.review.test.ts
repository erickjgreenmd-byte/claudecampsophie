import { describe, expect, it } from 'vitest';
import { createChunkedStorage } from './chunked-storage.ts';
import type { SecureStorage } from './mode.ts';

/**
 * Lead adversarial review, identity/access slice (spec P3 parent session on a shared device).
 * RV-lead-identity-access-10: chunked-storage.ts promises "a crash mid-write leaves either the old
 * complete value or a readable new one — never a mixed session". Chunks are overwritten IN PLACE
 * under the same keys before the count is written, so an app kill / keychain error after the first
 * chunk leaves new chunk 0 + old chunks 1..n-1 under the old count, which getItem() returns as a
 * well-formed session. Synthetic token strings only.
 */

/** In-memory keychain whose writes start failing after `okWrites` successful ones (app killed). */
function crashingKeychain(): SecureStorage & {
  data: Map<string, string>;
  crashAfter: (n: number) => void;
} {
  const data = new Map<string, string>();
  let remaining = Number.POSITIVE_INFINITY;
  return {
    data,
    crashAfter(n) {
      remaining = n;
    },
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      if (remaining <= 0) return Promise.reject(new Error('process killed'));
      remaining -= 1;
      data.set(k, v);
      return Promise.resolve();
    },
    deleteItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
}

/** Supabase-shaped session JSON; a token refresh keeps every length the same. */
function session(tag: 'A' | 'B'): string {
  return JSON.stringify({
    access_token: `eyJ${tag.repeat(2000)}`,
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: `rt-${tag.repeat(12)}`,
    user: { id: '00000000-0000-4000-8000-00000000000a', email: 'riley.parent@example.test' },
  });
}

describe('RV-lead-identity-access-10: a crash while saving a refreshed session never yields a mixed session', () => {
  it('after a failed overwrite the stored value is the old session, the new one, or nothing', async () => {
    const keychain = crashingKeychain();
    const storage = createChunkedStorage(keychain); // default 1800-char chunks, as in the app
    const oldSession = session('A');
    const newSession = session('B');
    await storage.setItem('sb-proj-auth-token', oldSession);

    keychain.crashAfter(1); // the first new chunk is written, then the app dies
    await expect(storage.setItem('sb-proj-auth-token', newSession)).rejects.toThrow();

    const read = await storage.getItem('sb-proj-auth-token');
    // The mixed value parses as a session whose access token is half new/half old and whose refresh
    // token is the already-rotated OLD one (presenting it trips Supabase refresh-token reuse).
    expect([oldSession, newSession, null]).toContain(read);
  });
});

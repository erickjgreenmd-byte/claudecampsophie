import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '@pencillift/db/testing';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { cryptoRandom } from '@pencillift/domain';
import { createApp, MAX_JSON_BYTES } from '../src/app.ts';
import { createParentVerifier } from '../src/auth/parent.ts';
import {
  clientNetworkKey,
  clientSiteKey,
  createDbRateLimiter,
  RATE_RULES,
} from '../src/middleware/rate-limit.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

/**
 * Child pairing and session hardening around the identity review fixes
 * (RV-lead-identity-access-5/6/7/8 and review note e). Real local Postgres; synthetic data only.
 */

let api: TestApi;
const FIXED_NOW = new Date('2026-09-24T15:00:00Z');

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

let seq = 0;
async function familyWithActiveChild(): Promise<{
  fam: SeededFamily;
  childId: string;
  token: string;
}> {
  const fam = await seedFamily(api.db, { childCount: 1 });
  seq += 1;
  const sessionId = `c4a1${seq.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
  await grantAdultUnlock(api.db, fam.ownerId, sessionId, 3600);
  return {
    fam,
    childId: fam.children[0]!.id,
    token: await parentToken(fam.ownerId, { sessionId }),
  };
}

const newCode = (token: string, childId: string) =>
  api.request(`/v1/children/${childId}/pairing-code`, { method: 'POST', token });

const pair = (code: string, ip: string) =>
  api.request('/v1/child/pair', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
    body: { code, deviceLabel: 'Kitchen tablet', platform: 'ios' },
  });

describe('client network keys for rate limits (RV-lead-identity-access-6)', () => {
  it('IPv4 is per address, IPv6 per /64, mapped IPv4 is IPv4, junk shares one bucket', () => {
    expect(clientNetworkKey('198.51.100.7')).toBe('v4:198.51.100.7');
    expect(clientNetworkKey('198.51.100.8')).not.toBe(clientNetworkKey('198.51.100.7'));
    expect(clientNetworkKey('2001:db8:77:1::1')).toBe(
      clientNetworkKey('2001:0db8:0077:0001:ffff::9'),
    );
    expect(clientNetworkKey('2001:db8:77:1::1')).toBe('v6:2001:db8:77:1::/64');
    expect(clientNetworkKey('2001:db8:77:2::1')).not.toBe(clientNetworkKey('2001:db8:77:1::1'));
    expect(clientNetworkKey('::ffff:198.51.100.7')).toBe('v4:198.51.100.7');
    expect(clientNetworkKey('::ffff:c633:6407')).toBe('v4:198.51.100.7');
    expect(clientNetworkKey('fe80::1%eth0')).toBe('v6:fe80:0:0:0::/64');
    expect(clientNetworkKey('::')).toBe('v6:0:0:0:0::/64');
    for (const junk of [
      undefined,
      '',
      'unknown',
      '999.1.1.1',
      '1:2:3',
      '2001:db8::1::2',
      'a'.repeat(50),
    ]) {
      expect(clientNetworkKey(junk)).toBe('unknown');
    }
  });

  it('spelling variants of one address share a key; unusual forms fail closed into one bucket', () => {
    // Lead review of the re-fix: case and surrounding space never split one client into several
    // buckets. A bracketed form (which Cloudflare's cf-connecting-ip never sends) is refused into
    // the shared 'unknown' bucket, which only ever limits more, never less.
    for (const key of [clientNetworkKey, clientSiteKey]) {
      expect(key('2001:DB8:77:1::1')).toBe(key('2001:db8:77:1::1'));
      expect(key(' 198.51.100.7 ')).toBe(key('198.51.100.7'));
      expect(key('::FFFF:198.51.100.7')).toBe(key('198.51.100.7'));
      expect(key('[2001:db8:77:1::1]')).toBe('unknown');
    }
  });

  it('separate IPv4 addresses keep separate limits; one address is limited at 21 guesses', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await pair('ZZZZ-ZZZZ', '192.0.2.10')).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await pair('ZZZZ-ZZZZ', '192.0.2.11')).status).toBe(404);
  });

  it('the budget and its pause are per site: an IPv4 /24 or an IPv6 /48', () => {
    expect(clientSiteKey('198.51.100.7')).toBe('v4:198.51.100.0/24');
    expect(clientSiteKey('198.51.100.250')).toBe(clientSiteKey('198.51.100.7'));
    expect(clientSiteKey('198.51.101.7')).not.toBe(clientSiteKey('198.51.100.7'));
    expect(clientSiteKey('2001:db8:77:1::1')).toBe('v6:2001:db8:77::/48');
    expect(clientSiteKey('2001:db8:77:ffff::9')).toBe(clientSiteKey('2001:db8:77:1::1'));
    expect(clientSiteKey('2001:db8:78:1::1')).not.toBe(clientSiteKey('2001:db8:77:1::1'));
    expect(clientSiteKey('::ffff:198.51.100.7')).toBe('v4:198.51.100.0/24');
    for (const junk of [undefined, '', 'unknown', '999.1.1.1', '2001:db8::1::2']) {
      expect(clientSiteKey(junk)).toBe('unknown');
    }
  });
});

/**
 * The service-wide budget of failed code redemptions (RV-lead-identity-access-6, checker follow-up).
 * A guess reserves its unit before it runs, so guesses in flight count (AC_SECURITY_06); a success
 * gives the unit back. A used-up budget pauses only the sites (IPv4 /24, IPv6 /48) that already
 * have a failed or running guess in the window, so spending it cannot stop every family pairing.
 */
describe('service-wide pairing failure budget (RV-lead-identity-access-6)', () => {
  const GLOBAL = RATE_RULES.pairingRedeemFailuresGlobal;

  async function setGlobalFailures(hits: number): Promise<void> {
    const size = GLOBAL.windowSeconds * 1000;
    const start = new Date(Math.floor(api.now.value.getTime() / size) * size);
    await api.db.sql`
      insert into private.rate_limit_buckets (bucket_key, window_start, hits, updated_at, expires_at)
      values ('pair-fail:global', ${start}, ${hits}, ${api.now.value}, ${new Date(start.getTime() + size)})
      on conflict (bucket_key) do update
        set window_start = excluded.window_start, hits = excluded.hits, expires_at = excluded.expires_at`;
  }

  async function hits(key: string): Promise<number> {
    const [row] = await api.db.sql<{ hits: number }[]>`
      select hits from private.rate_limit_buckets where bucket_key = ${key}`;
    return row?.hits ?? 0;
  }

  const alerted = (from: number) =>
    api.logs
      .slice(from)
      .some((e) => e.event === 'pairing_failure_budget_exhausted' && e.level === 'error');

  afterEach(async () => {
    api.now.value = FIXED_NOW;
    await setGlobalFailures(0);
  });

  it('counts guesses in flight: with one failure left, 40 simultaneous guesses from one /24 check one code', async () => {
    await setGlobalFailures(GLOBAL.limit - 1);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => pair('ZZZZ-ZZZZ', `198.51.100.${i + 1}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 404)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(39);
    expect(results.find((r) => r.status === 429)!.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    // A refused request is not a guess: the budget holds exactly the one failure that ran.
    expect(await hits('pair-fail:global')).toBe(GLOBAL.limit);
  });

  it('the same holds for simultaneous guesses from 40 different /64s of one IPv6 /48', async () => {
    await setGlobalFailures(GLOBAL.limit - 1);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        pair('ZZZZ-ZZZZ', `2001:db8:4400:${(i + 1).toString(16)}::1`),
      ),
    );
    expect(results.filter((r) => r.status === 404)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(39);
  });

  it('an attacker who spends the whole budget pauses only their own site; another family still pairs', async () => {
    for (let n = 1; n <= 10; n += 1) {
      for (let i = 0; i < 20; i += 1) {
        expect((await pair('ZZZZ-ZZZZ', `100.64.1.${n}`)).status).toBe(404);
      }
    }
    expect(await hits('pair-fail:global')).toBe(GLOBAL.limit);
    const logsBefore = api.logs.length;
    // A fresh address in the attacker's /24 is paused, and the exhaustion is alerted.
    const paused = await pair('ZZZZ-ZZZZ', '100.64.1.99');
    expect(paused.status).toBe(429);
    expect(alerted(logsBefore)).toBe(true);
    // A family on a site with no failed guesses pairs normally, and its success costs nothing.
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    expect((await pair(code, '198.18.7.200')).status).toBe(201);
    expect(await hits('pair-fail:global')).toBe(GLOBAL.limit);
    expect(await hits('pair-fail:v4:198.18.7.0/24')).toBe(0);
  });

  it('while the budget is used up a clean site gets one attempt; after a wrong code it waits for the next window', async () => {
    await setGlobalFailures(GLOBAL.limit);
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    expect((await pair('ZZZZ-ZZZZ', '198.18.8.1')).status).toBe(404);
    const waiting = await pair(code, '198.18.8.2');
    expect(waiting.status).toBe(429);
    expect(Number(waiting.headers.get('retry-after'))).toBeGreaterThan(0);

    api.now.value = new Date(FIXED_NOW.getTime() + GLOBAL.windowSeconds * 1000);
    const { code: fresh } = await json<{ code: string }>(await newCode(token, childId));
    expect((await pair(fresh, '198.18.8.2')).status).toBe(201);
  });

  it('successes do not spend the budget; failures do', async () => {
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    expect((await pair(code, '198.18.9.1')).status).toBe(201);
    expect(await hits('pair-fail:global')).toBe(0);
    expect(await hits('pair-fail:v4:198.18.9.0/24')).toBe(0);
    expect((await pair('ZZZZ-ZZZY', '198.18.9.1')).status).toBe(404);
    expect(await hits('pair-fail:global')).toBe(1);
    expect(await hits('pair-fail:v4:198.18.9.0/24')).toBe(1);
  });
  it('a budget release that fails never fails a pairing that already happened', async () => {
    const limiter = createDbRateLimiter(api.apiDb);
    const app = createApp({
      config: api.config,
      db: api.apiDb,
      clock: () => api.now.value,
      random: cryptoRandom,
      verifyParentToken: createParentVerifier(api.config),
      rateLimiter: { ...limiter, release: () => Promise.reject(new Error('database unavailable')) },
      providers: api.providers,
      log: (e) => api.logs.push(e),
    });
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    const logsBefore = api.logs.length;
    const res = await app.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.18.10.1' },
      body: JSON.stringify({ code, deviceLabel: 'Kitchen tablet', platform: 'ios' }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ refreshToken: string }>(res)).refreshToken).toBeTruthy();
    expect(
      api.logs.slice(logsBefore).some((e) => e.event === 'pairing_budget_release_failed'),
    ).toBe(true);
    // Conservatively spent: the unit stays counted.
    expect(await hits('pair-fail:global')).toBe(1);
  });
});

describe('pairing codes (RV-lead-identity-access-7, review note e)', () => {
  it('three overlapping "new code" requests leave exactly one live code, and only it pairs', async () => {
    const { childId, token } = await familyWithActiveChild();
    const created = await Promise.all([
      newCode(token, childId),
      newCode(token, childId),
      newCode(token, childId),
    ]);
    expect(created.map((r) => r.status)).toEqual([201, 201, 201]);
    const [live] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where child_id = ${childId} and consumed_at is null`;
    expect(live!.n).toBe(1);
    const codes = await Promise.all(created.map((r) => json<{ code: string }>(r)));
    const paired: number[] = [];
    for (const { code } of codes) paired.push((await pair(code, '203.0.113.41')).status);
    expect(paired.sort()).toEqual([201, 404, 404]);
  });

  it('a "new code" request takes the child row before any code row, so overlapping requests never deadlock (BUG-106)', async () => {
    const { childId, token } = await familyWithActiveChild();
    expect((await newCode(token, childId)).status).toBe(201); // one live code exists
    const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
    url.pathname = `/${api.db.name}`;
    const other = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    let request: Promise<Response> | undefined;
    try {
      // A concurrent "new code" insert paused inside its trigger: it holds the child row and next
      // retires the live code. The request must wait for the child row without holding that code.
      const outcome = await other
        .begin(async (tx) => {
          await tx`select 1 from public.child_profiles where id = ${childId} for no key update`;
          request = newCode(token, childId);
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const [row] = await tx<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
               where datname = current_database() and pid <> pg_backend_pid()
                 and wait_event_type = 'Lock'`;
            if (row!.n >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await tx`
            update private.child_pairing_codes set consumed_at = ${api.now.value}
             where child_id = ${childId} and consumed_at is null`;
          return 'retired';
        })
        .catch((error: unknown) => (error as { code?: string }).code ?? 'error');
      expect(outcome).toBe('retired');
      expect((await request!).status).toBe(201);
    } finally {
      await request?.catch(() => undefined);
      await other.end();
    }
    const [live] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where child_id = ${childId} and consumed_at is null`;
    expect(live!.n).toBe(1);
  });

  it('archiving ends unredeemed codes even when the child is never re-activated', async () => {
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    expect(
      (await api.request(`/v1/children/${childId}/archive`, { method: 'POST', token })).status,
    ).toBe(200);
    const [live] = await api.db.sql<{ n: number }[]>`
      select count(*)::int as n from private.child_pairing_codes
       where child_id = ${childId} and consumed_at is null`;
    expect(live!.n).toBe(0);
    expect((await pair(code, '203.0.113.42')).status).toBe(404);
  });
});

describe('child session lifetime uses the database clock (RV-lead-identity-access-8)', () => {
  it('a device paired while the request clock is 40 days behind keeps working and refreshing', async () => {
    const { childId, token } = await familyWithActiveChild();
    const { code } = await json<{ code: string }>(await newCode(token, childId));
    const [db] = await api.db.sql<{ now: Date }[]>`select now() as now`;
    // Beyond the 30-day session lifetime: a session written with this clock would already be over.
    api.now.value = new Date(db!.now.getTime() - 40 * 86_400_000);
    try {
      const paired = await pair(code, '203.0.113.43');
      expect(paired.status).toBe(201);
      const tokens = await json<{ accessToken: string; refreshToken: string }>(paired);
      expect((await api.request('/v1/child/me', { token: tokens.accessToken })).status).toBe(200);
      const refreshed = await api.request('/v1/child/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(refreshed.status).toBe(200);
    } finally {
      api.now.value = FIXED_NOW;
    }
  });
});

describe('streamed request bodies (RV-lead-identity-access-5)', () => {
  function streamed(text: string, chunk = 4096): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
        controller.close();
      },
    });
  }

  const post = (body: ReadableStream<Uint8Array>) =>
    api.app.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.44' },
      body,
      duplex: 'half',
    } as RequestInit);

  it('a streamed body within the limit is read normally; one byte over is refused', async () => {
    const base = JSON.stringify({ code: 'ZZZZ-ZZZZ', deviceLabel: 'Tablet', platform: 'ios' });
    expect((await post(streamed(base))).status).toBe(404);
    // Pad with JSON whitespace to exactly the limit (still one valid document).
    const atLimit = base + ' '.repeat(MAX_JSON_BYTES - base.length);
    expect((await post(streamed(atLimit))).status).toBe(404);
    const res = await post(streamed(`${atLimit} `));
    expect(res.status).toBe(413);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

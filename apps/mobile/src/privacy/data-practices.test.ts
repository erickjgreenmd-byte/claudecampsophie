import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DATA_PRACTICES_COPY } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { describe, expect, it } from 'vitest';
import {
  dataPracticesDetail,
  dataPracticesStrip,
  loadDataPractices,
  UNKNOWN_DATA_PRACTICES,
} from './data-practices.ts';

/**
 * A client whose GET answers with `body`, or throws it when it is an Error. It VALIDATES against the
 * schema it is handed, because the real `createApiClient` does and a fake that skips validation
 * tests a client nobody ships. The first version of this helper did skip it — and that is what
 * exposed `loadDataPractices` trusting its caller for validation.
 */
function fakeApi(body: unknown): ApiClient {
  return {
    get: (_path: string, schema: { parse: (value: unknown) => unknown }) =>
      body instanceof Error ? Promise.reject(body) : Promise.resolve(schema.parse(body)),
    send: () => Promise.reject(new Error('unexpected send')),
  } as unknown as ApiClient;
}

describe('the phone discloses when it does not know', () => {
  it('starts on the wider case, never the comfortable one', () => {
    const strip = dataPracticesStrip(UNKNOWN_DATA_PRACTICES);
    expect(strip.sentence).toBe(DATA_PRACTICES_COPY.unconfirmed);
    expect(strip.sentence).not.toBe(DATA_PRACTICES_COPY.childWork.not_sent);
    // The direction of the fallback, asserted on the words rather than on the state name: a
    // sentence rewritten into something soothing would otherwise pass every case in this file.
    expect(strip.sentence).toContain('OpenAI');
  });

  it('a refused request, a timeout and a body the schema rejects all land on the wider case', async () => {
    for (const body of [
      new Error('offline'),
      { childWork: 'unknown', adultId: 'not_sent' },
      { childWork: 'openai_under_zdr' },
      { childWork: 'openai_under_zdr', adultId: 'not_sent', zdrReference: 'OAI-SYNTHETIC-0001' },
      null,
    ]) {
      expect(await loadDataPractices(fakeApi(body)), JSON.stringify(body)).toEqual(
        UNKNOWN_DATA_PRACTICES,
      );
    }
  });

  it('a client that does NOT validate still cannot make it half-believe a body', async () => {
    // The guarantee has to belong to this function, not to whichever client is passed in: a caller
    // wiring a plain fetch wrapper is the realistic way a bad body arrives, and the value it would
    // have set here (`adultId: 'not_sent'`) is the reassuring one.
    const unvalidating = {
      get: () => Promise.resolve({ childWork: 'definitely_fine', adultId: 'not_sent' }),
      send: () => Promise.reject(new Error('unexpected send')),
    } as unknown as ApiClient;
    expect(await loadDataPractices(unvalidating)).toEqual(UNKNOWN_DATA_PRACTICES);
  });

  it('a published pair is taken as published', async () => {
    expect(
      await loadDataPractices(
        fakeApi({ childWork: 'openai_under_zdr', adultId: 'identity_vendor' }),
      ),
    ).toEqual({ childWork: 'openai_under_zdr', adultId: 'identity_vendor' });
  });
});

describe('what the strip shows and what the privacy screen shows', () => {
  it('the strip carries one sentence; the screen carries both', () => {
    const state = { childWork: 'openai_under_zdr', adultId: 'openai_under_zdr' } as const;
    expect(dataPracticesStrip(state).sentence).toBe(DATA_PRACTICES_COPY.childWork.openai_under_zdr);
    expect(dataPracticesDetail(state)).toEqual([
      DATA_PRACTICES_COPY.childWork.openai_under_zdr,
      DATA_PRACTICES_COPY.adultId.openai_under_zdr,
    ]);
  });

  it('an unknown adult-ID state adds no sentence rather than a vague one', () => {
    expect(dataPracticesDetail(UNKNOWN_DATA_PRACTICES)).toEqual([DATA_PRACTICES_COPY.unconfirmed]);
  });

  it('every sentence the phone prints is one of the shared ones', () => {
    /*
     * The parity rule for this feature, and it is a SUBSET rule rather than an equality: the phone
     * shows less than the portal on purpose (a permanent three-line strip does not fit), and the
     * guarantee that matters is that it never shows anything of its OWN. Rounds have gone into
     * deleting second copies of sentences (L-070, BUG-411); this keeps a new one from appearing.
     */
    const shared = new Set<string>([
      ...Object.values(DATA_PRACTICES_COPY.childWork),
      ...Object.values(DATA_PRACTICES_COPY.adultId),
      DATA_PRACTICES_COPY.unconfirmed,
    ]);
    const states = [
      UNKNOWN_DATA_PRACTICES,
      { childWork: 'not_sent', adultId: 'not_sent' },
      { childWork: 'openai_under_zdr', adultId: 'openai_under_zdr' },
      { childWork: 'not_sent', adultId: 'identity_vendor' },
    ] as const;
    for (const state of states) {
      expect(shared.has(dataPracticesStrip(state).sentence), state.childWork).toBe(true);
      for (const line of dataPracticesDetail(state)) expect(shared.has(line), line).toBe(true);
    }
  });
});

describe('the notice is a parent’s, not a child’s', () => {
  /*
   * A child can neither act on a notice about which companies read homework nor consent to it, and
   * the brand guide asks the child space to stay playful rather than becoming a wall of policy. So
   * this is a rule about the product, enforced by reading which files mount the component.
   */
  const APP_DIR = join(import.meta.dirname, '..', '..', 'app');

  function appFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return appFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('only the parent layout mounts it, and no child screen does', () => {
    const files = appFiles(APP_DIR);
    // The sweep is evidence only if it read the layouts (BUG-431): an empty list of mounters is
    // indistinguishable from "nothing mounts it", which is half of what this case checks.
    const relative_ = (path: string) => relative(APP_DIR, path).split(sep).join('/');
    expect(files.map(relative_)).toContain('(parent)/_layout.tsx');
    expect(files.map(relative_)).toContain('(child)/_layout.tsx');
    const mounters = files
      .filter((path) =>
        readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/^[ \t]*\/\/.*$/gm, ' ')
          .includes('<DataPracticesNotice'),
      )
      .map(relative_);
    expect(mounters).toEqual(['(parent)/_layout.tsx']);
  });
});

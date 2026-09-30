// The status note beside a points balance, on the portal (BUG-411 (c)). Synthetic names only.
//
// Every string asserted here is a LITERAL, never `rewardBalanceStatusNote(...)` itself: comparing the
// DOM against the helper that produced it is a tautology that survives any change to the sentence,
// which is the whole reason the previous round's parity tests passed over a reverted portal sentence
// (BUG-410, L-070). The literals here and the literals in
// apps/mobile/src/rewards/balance-status.test.ts are what make a change to the shared definition in
// packages/contracts/src/family.ts red on BOTH surfaces.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { RewardChildBalance, RewardsOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import RewardsPage from './RewardsPage.tsx';

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const JORDAN = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const CASEY = '4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8e';

const RULES = {
  rules: {
    attemptPoints: 2,
    independentCorrectBonus: 3,
    setCompletionPoints: 5,
    minMeaningfulResponseMs: 1500,
  },
  suggested: {
    attemptPoints: 2,
    independentCorrectBonus: 3,
    setCompletionPoints: 5,
    minMeaningfulResponseMs: 1500,
  },
  updatedAt: null,
};

/** The whole representative set: every status GET /v1/rewards can answer with (L-057). */
const CHILDREN: RewardChildBalance[] = [
  { childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' },
  { childId: JORDAN, nickname: 'Jordan', balance: 30, status: 'archived' },
  { childId: CASEY, nickname: 'Casey', balance: 7, status: 'draft' },
];

/** Fake API that validates the fixture through the real contract schema. */
function fakeApi(children: RewardChildBalance[]) {
  const overview: RewardsOverview = {
    rewards: [],
    children,
    openRequests: [],
    recentRequests: [],
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      try {
        return Promise.resolve(schema.parse(path === '/v1/reward-rules' ? RULES : overview));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return api;
}

async function balanceRows(children: RewardChildBalance[]): Promise<Map<string, string>> {
  renderPage(<RewardsPage />, { api: fakeApi(children) });
  const balances = await screen.findByRole('region', { name: 'Points balances' });
  const rows = new Map<string, string>();
  for (const item of within(balances).getAllByRole('listitem')) {
    const name = within(item).getByRole('strong', { hidden: true }).textContent ?? '';
    rows.set(name, item.textContent ?? '');
  }
  return rows;
}

afterEach(() => {
  cleanup();
});

describe('points balance status note (portal)', () => {
  it('prints the closed-profile note for every status that is not active, and none for active', async () => {
    const rows = await balanceRows(CHILDREN);
    expect(rows.get('Riley')).toContain('12 points');
    // A live balance carries no note: nothing in parentheses, and no "history only" claim.
    expect(rows.get('Riley')).not.toMatch(/history only|\(/);
    expect(rows.get('Jordan')).toContain('30 points');
    expect(rows.get('Jordan')).toContain('(archived — history only)');
    expect(rows.get('Casey')).toContain('7 points');
    expect(rows.get('Casey')).toContain('(no paid slot — history only)');
  });

  it('says "no paid slot" only about a draft profile, never about an archived one', async () => {
    // The row used to be built from `status === 'archived' ? 'archived' : 'no paid slot'`, so the
    // cause was asserted for anything that was not archived. Both named arms are checked here so a
    // future edit cannot swap them and stay green.
    const rows = await balanceRows(CHILDREN);
    expect(rows.get('Jordan')).not.toMatch(/no paid slot/);
    expect(rows.get('Casey')).not.toMatch(/archived/);
  });

  it('keeps the note out of the pickers, which offer active profiles only', async () => {
    renderPage(<RewardsPage />, { api: fakeApi(CHILDREN) });
    const adjust = await screen.findByRole('form', { name: 'Adjust points' });
    const options = within(within(adjust).getByLabelText('Child')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Choose a child', 'Riley']);
  });

  it('prints the note from the shared definition and holds no wording of its own', () => {
    // Not a pin on the other surface's source (that is what BUG-410 showed to be worthless), but on
    // THIS page: the sentence must not come back as a local literal beside the shared call. The
    // mutation evidence for the sharing itself is in the report: changing the definition in
    // packages/contracts/src/family.ts reds tests here AND in apps/mobile.
    const source = readFileSync(join(import.meta.dirname, 'RewardsPage.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/rewardBalanceStatusNote\(child\)/);
    expect(code).not.toMatch(/history only|no paid slot/);
  });
});

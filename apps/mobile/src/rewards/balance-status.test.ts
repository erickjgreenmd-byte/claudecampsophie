// The status note beside a points balance, on the phone (BUG-411 (c)). Synthetic names only.
//
// Every expected string here is a LITERAL, never `rewardBalanceStatusNote(...)`: asserting the view
// model against the helper that built it is a tautology that survives any change to the sentence,
// which is how the mobile suite stayed green at 859/859 over a reverted portal sentence (BUG-410,
// L-070). These literals and the ones in apps/web/src/pages/app/RewardsBalanceStatus.test.tsx are
// what make a change to the shared definition in packages/contracts/src/family.ts red on BOTH
// surfaces.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RewardChildBalance, RewardsOverview } from '@pencillift/contracts';
import { buildParentApprovalsView } from './parent-view-model.ts';

const RILEY = '66666666-6666-4666-8666-666666666666';
const JORDAN = '77777777-7777-4777-8777-777777777777';
const CASEY = '88888888-8888-4888-8888-888888888888';

/** The whole representative set: every status GET /v1/rewards can answer with (L-057). */
const CHILDREN: RewardChildBalance[] = [
  { childId: RILEY, nickname: 'Riley', balance: 12, status: 'active' },
  { childId: JORDAN, nickname: 'Jordan', balance: 30, status: 'archived' },
  { childId: CASEY, nickname: 'Casey', balance: 7, status: 'draft' },
];

function overview(children: readonly RewardChildBalance[]): RewardsOverview {
  return { rewards: [], children: [...children], openRequests: [], recentRequests: [] };
}

/** What the screen receives, keyed by nickname: `app/(parent)/rewards.tsx` prints these strings. */
function labels(children: readonly RewardChildBalance[]): string[] {
  return buildParentApprovalsView(overview(children), 'UTC').balances.map((b) => b.label);
}

describe('points balance status note (phone)', () => {
  it('prints the closed-profile note for every status that is not active, and none for active', () => {
    // The whole line is asserted, not a fragment: the note reaches the parent only if it is part of
    // the string the screen prints (see `balanceLine`).
    expect(labels(CHILDREN)).toEqual([
      'Riley: 12 points',
      'Jordan: 30 points (archived — history only)',
      'Casey: 7 points (no paid slot — history only)',
    ]);
  });

  it('says "no paid slot" only about a draft profile, never about an archived one', () => {
    const [, jordan, casey] = labels(CHILDREN);
    expect(jordan).not.toMatch(/no paid slot/);
    expect(casey).not.toMatch(/archived/);
  });

  it('claims no cause for a status the app has not heard of, only the consequence', () => {
    // `rewardChildBalanceSchema` is an enum, so this cannot arrive from the API today; the cast is
    // what a widened contract would hand this view model, and the point is that it lands on the
    // honest branch rather than on the draft arm's "no paid slot" (BUG-406).
    const widened = [
      { childId: RILEY, nickname: 'Riley', balance: 4, status: 'suspended' },
    ] as unknown as RewardChildBalance[];
    expect(labels(widened)).toEqual(['Riley: 4 points (history only)']);
  });

  it('keeps the singular for one point, with and without a note', () => {
    expect(
      labels([
        { childId: RILEY, nickname: 'Riley', balance: 1, status: 'active' },
        { childId: JORDAN, nickname: 'Jordan', balance: 1, status: 'archived' },
      ]),
    ).toEqual(['Riley: 1 point', 'Jordan: 1 point (archived — history only)']);
  });

  it('the screen prints the prepared line and builds no status text of its own', () => {
    // The screens import react-native, which this pure-logic suite cannot render (see
    // vitest.config.ts), so this reads the source. It pins THIS surface's wiring — the one thing a
    // source read can honestly establish — not the other surface's words (BUG-410).
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'app', '(parent)', 'rewards.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toMatch(/view\.balances\.map\(/);
    expect(code).toMatch(/\{b\.label\}/);
    // No copy of the sentence, and no branch on a CHILD's status (`state.status` is this screen's
    // own load state, which is why the check names the child).
    expect(code).not.toMatch(/history only|no paid slot|archived/);
    expect(code).not.toMatch(/\bc\.status|child\.status/);
  });
});

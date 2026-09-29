// Independent adversarial review of the rewards vertical (fresh context). Synthetic data only.
// Screens import react-native, which this vitest setup cannot render (see vitest.config.ts), so
// the screen-level findings check the screen source for the gate/route they must use.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChildRewards } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { buildChildRewardsView } from './child-view-model.ts';
import { createRequestIds, decideRequestAction } from './actions.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..', 'app');
const parentRewardsScreen = readFileSync(join(appDir, '(parent)', 'rewards.tsx'), 'utf8');

/** Source without comments, so a comment mentioning a gate cannot satisfy the check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const AT = '2026-09-20T15:00:00.000Z';

function childData(overrides: Partial<ChildRewards> = {}): ChildRewards {
  return {
    balance: 0,
    rewards: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Trip to the library',
        pointCost: 10,
        instructions: null,
      },
    ],
    requests: [],
    earningRules: { pointsPerTry: 2, firstTryBonus: 3, setCompletionPoints: 5 },
    ...overrides,
  };
}

describe('rewards review findings (mobile)', () => {
  it('[RV-rewards-3] the parent rewards screen refuses to show family data while the device is in child mode', () => {
    // P3 / AC_ACCESS_07: a shared device must not retain a usable parent session accessible from
    // child mode. Every other parent screen gates on useParentAccess() (child_mode state), and
    // enterChildMode() does not sign the parent out, so the rewards token source stays registered.
    const src = code(parentRewardsScreen);
    expect(/\buseParentAccess\s*\(|\bcurrentMode\s*\(/.test(src)).toBe(true);
  });

  it('[RV-rewards-4] a STEP_UP_REQUIRED decision gives the parent a way to unlock', async () => {
    // Web shows a link to the unlock page; the other mobile parent screens render
    // ErrorBox needsPin (an "Unlock with parent PIN" button). The rewards screen only prints text.
    const api = {
      send: () => Promise.reject(new ApiRequestError('STEP_UP_REQUIRED', 'Enter PIN', 403)),
    } as unknown as ApiClient;
    const result = await decideRequestAction(
      api,
      {
        id: '44444444-4444-4444-8444-444444444444',
        childId: '55555555-5555-4555-8555-555555555555',
        childNickname: 'Riley',
        rewardId: '11111111-1111-4111-8111-111111111111',
        rewardTitle: 'Trip to the library',
        pointCost: 10,
        state: 'pending',
        requestedAt: AT,
        decidedAt: null,
        fulfilledAt: null,
        cancelledBy: null,
      },
      'approve',
    );
    expect(result.needsPin).toBe(true);
    const src = code(parentRewardsScreen);
    const offersUnlock =
      /\/\(parent\)\/unlock/.test(src) || /<ErrorBox[^>]*needsPin/.test(src.replace(/\s+/g, ' '));
    expect(offersUnlock).toBe(true);
  });

  it('[RV-rewards-5] child encouragement does not promise that every bit of practice earns points', () => {
    // P9: awards are capped per unique question/set and rapid empty guesses or retries must not
    // farm points, so "every bit of practice adds points" promises more than the product does.
    const view = buildChildRewardsView(childData({ balance: 0 }));
    expect(view.encouragement).not.toMatch(
      /\b(every|all|any)\b[^.!?]*\bpractice\b[^.!?]*\bpoints?\b/i,
    );
  });

  it('[RV-rewards-6] the parent approvals screen is reachable from the parent area', () => {
    // P14 lists "rewards manager, requests" as parent screens and AC_UX_02 requires connected
    // behaviour. No parent screen navigates to /(parent)/rewards, so the screen cannot be opened.
    const parentDir = join(appDir, '(parent)');
    const linked = readdirSync(parentDir)
      .filter((f) => f.endsWith('.tsx') && f !== 'rewards.tsx')
      .some((f) => /\/\(parent\)\/rewards\b/.test(code(readFileSync(join(parentDir, f), 'utf8'))));
    expect(linked).toBe(true);
  });
});

describe('rewards review probes (mobile, held up)', () => {
  it('probe: an offline ask keeps its request id for the retry; a definite answer releases it', () => {
    let n = 0;
    const ids = createRequestIds(() => `id-${++n}`);
    const first = ids.idFor('reward-a');
    expect(ids.idFor('reward-a')).toBe(first);
    expect(ids.idFor('reward-b')).not.toBe(first);
    ids.settle('reward-a');
    expect(ids.idFor('reward-a')).not.toBe(first);
  });

  it('probe: child copy for every request state avoids money and wallet words', () => {
    const view = buildChildRewardsView(
      childData({
        balance: 3,
        requests: (['pending', 'approved', 'fulfilled', 'declined', 'cancelled'] as const).map(
          (state, i) => ({
            id: `6666666${i}-6666-4666-8666-666666666666`,
            rewardId: '11111111-1111-4111-8111-111111111111',
            rewardTitle: null,
            pointCost: 10,
            state,
            requestedAt: AT,
            decidedAt: null,
            fulfilledAt: null,
          }),
        ),
      }),
    );
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/\$|\b(cash|money|wallet|dollars?|buy|purchase|pay|paid|shop)\b/i);
  });
});

/**
 * HUNT7-J-4. The parent Rewards screen owns its fetch instead of using the shared `useLoad`, and round
 * 6 gave it only the first half of HUNT6-I-2: `setState({status:'loading'})` before the load, so the
 * previous adult's rows go before the request — but no run ticket, so whichever request ANSWERS last
 * publishes. `useLoad` (src/family/ui.tsx) and the privacy screen both got the ticket in that same
 * commit; this screen did not, and nothing pinned either half of it here.
 *
 * Four callers can overlap: the mount/identity effect, pull-to-refresh, the error retry and the reload
 * after a decision. The last is the reachable one — `decide` clears `busy` BEFORE awaiting the reload,
 * so every button is live again while it is in flight, and approving a second card starts a second
 * decision and a second reload. Reload #1 answering after reload #2 restores the list as it was before
 * the second decision, with Approve/Decline on a request the server has already decided: exactly the
 * state the reload at RV-rewards-7 exists to prevent. The same unguarded publish serves the previous
 * family's child nicknames and point balances to the next adult at a handed-on tablet, since the gate
 * publishes a new client for a new adult while the old client's request is still out.
 *
 * A source pin, in the style of the `useLoad` block in src/family/screens-r2.review.test.ts: this
 * screen imports react-native, which the project cannot render (see the file header).
 */
describe('the parent rewards screen publishes only its newest load (HUNT7-J-4)', () => {
  const src = code(parentRewardsScreen);

  it('[repro] the ticket is taken before the await and checked before every publish', () => {
    expect(src).toMatch(/const latestLoad = useRef\(0\)/);
    expect(src).toMatch(/latestLoad\.current \+= 1;\s*const ticket = latestLoad\.current;/);
    expect(src).toMatch(
      /const data = await loadRewardsOverview\(api\);\s*if \(latestLoad\.current !== ticket\) return;\s*setState\(\{ status: 'ready', data \}\);/,
    );
    // The error is a publish too: showing a superseded load's failure is the same lie about whose load
    // it is, and it would replace the rows the current adult's load is about to deliver.
    expect(src).toMatch(/\} catch \(error\) \{\s*if \(latestLoad\.current !== ticket\) return;/);
    // The unguarded publish itself: awaiting inside the setter leaves no place to check the ticket.
    expect(src).not.toMatch(
      /setState\(\{ status: 'ready', data: await loadRewardsOverview\(api\) \}\)/,
    );
  });

  it('keeps the other half: the rows go before the fetch, not when it answers (HUNT6-I-2)', () => {
    expect(src).toMatch(/setState\(\{ status: 'loading' \}\);\s*void load\(\);/);
    // And the load is keyed on the gate's client, which is what makes a new adult re-run it.
    expect(src).toMatch(/\}, \[api\]\);/);
  });
});

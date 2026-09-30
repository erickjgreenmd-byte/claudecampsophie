import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHILD_PROFILE_STATUSES,
  PAIRING_STALE_COPY,
  pairingStaleNextStep,
  type FamilyChild,
  type FamilyOverview,
  type HeldPairingCode,
} from '@pencillift/contracts';
import { childRows, pairDeviceView } from './family-view.ts';

/**
 * THE PHONE'S PAIR-DEVICE SCREEN (BUG-411 (g)).
 *
 * What it did before: `const [code, setCode] = useState<{ code: string; expiresAt: string } | null>`
 * and `if (code) return (<Card>…{code.code}…)`. No staleness branch, and no source for one — the
 * screen was reached with `childId`/`nickname` route params and fetched nothing at all, so it could
 * not observe the child's status even in principle. A parent read a code the tablet will refuse,
 * after a consent withdrawal retired it or after the child's status moved, with nothing saying so.
 * The portal spent BUG-393, BUG-395 and BUG-397 on exactly this rule.
 *
 * The rule is now `pairingRedeemable` / `heldPairingCode` in `packages/contracts/src/family.ts`,
 * which BOTH surfaces import and neither holds a copy of. These cases are aimed at the CALL SITE
 * (L-071): extracting the rule proves the rule, and says nothing about whether the screen hands it
 * the real state, so every assertion below is on the OUTPUT the screen renders from.
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const GONE = '9c4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f61';

const LIVE_CODE = { code: 'ABCD-EFGH', expiresAt: '2026-09-30T15:10:00.000Z' } as const;

function familyWith(riley: Partial<FamilyChild>): FamilyOverview {
  return {
    id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots: 2,
    billingConflict: null,
    managingChannel: null,
    children: [
      { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active', ...riley },
      { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
    ],
  };
}

const view = (family: FamilyOverview, held: HeldPairingCode, childId = RILEY) =>
  pairDeviceView(family, childId, 'your child', held);

describe('the pair-device screen decides staleness where the code is rendered (BUG-397)', () => {
  it('prints a code only while the profile it was minted for can still redeem it', () => {
    const shown = view(familyWith({ status: 'active' }), LIVE_CODE);
    expect(shown.held).toEqual(LIVE_CODE);
    expect(shown.canCreate).toBe(true);
    expect(shown.pairingNote).toBeNull();
  });

  /**
   * THE REPRESENTATIVE SET, not the two states the brief named (L-057). Every state that is not
   * "active, no deletion open" must reach the stale branch, including one this release has no name
   * for: a status added by a later migration must land on the honest branch by DEFAULT, because
   * `POST /v1/child-auth/pair` requires `c.status = 'active'` and nothing else can redeem a code.
   */
  const unredeemable: ReadonlyArray<readonly [string, Partial<FamilyChild>]> = [
    ['archived, which is where a child-scope deletion also puts them', { status: 'archived' }],
    ['a draft, whose slot was released when the plan lapsed', { status: 'draft' }],
    [
      'active with a family-scope deletion open, which leaves the status alone',
      {
        status: 'active',
        deletionPending: true,
      },
    ],
    [
      'archived AND deletion-pending, the child-scope case',
      {
        status: 'archived',
        deletionPending: true,
      },
    ],
    // Not a status this release defines; `familyChildSchema` would reject it, but the VIEW must not
    // depend on that — a later release adds one and this branch is what it lands on.
    ['a status this release has never heard of', { status: 'suspended' as FamilyChild['status'] }],
  ];

  for (const [label, child] of unredeemable) {
    it(`replaces the code with the stale notice for a child that is ${label}`, () => {
      const shown = view(familyWith(child), LIVE_CODE);
      expect(shown.held).toBe('stale');
      expect(shown.canCreate).toBe(false);
      // And the parent is told why, where the Create control would have been: a screen that just
      // stops offering the button is its own puzzle.
      expect(shown.pairingNote).not.toBeNull();
    });
  }

  it('covers every status this release defines, so none of them falls through unasserted', () => {
    const decided = CHILD_PROFILE_STATUSES.map((status) => [
      status,
      view(familyWith({ status }), LIVE_CODE).held,
    ]);
    expect(decided).toEqual([
      ['draft', 'stale'],
      ['active', LIVE_CODE],
      ['archived', 'stale'],
    ]);
  });

  it('holds nothing back for a child the family overview no longer lists', () => {
    // The screen is reached by id. A purge that finished, or an overview fetched under a membership
    // that no longer covers this child, means the row is simply absent — and a profile this client
    // cannot see is one it cannot claim anything about, so the code is not printed.
    const shown = view(familyWith({ status: 'active' }), LIVE_CODE, GONE);
    expect(shown.held).toBe('stale');
    expect(shown.canCreate).toBe(false);
    expect(shown.statusText).toBe('Status unavailable');
    expect(shown.pairingNote).toMatch(/no longer listed in your family/);
  });

  it('[repro] turns stale a code that ARRIVES after the status moved, not just one in hand', () => {
    // BUG-397's fall-through, and the reason this is a render-time decision rather than an effect:
    // the server minted a real code (its own `child.status !== 'active'` check passed when the POST
    // was made) and archiving does not consume an unexpired one, so the code that resolves into the
    // screen is live and unredeemable at once. `setHeld(result)` happens with the code in hand and
    // the new status already loaded; this call is the one that decides.
    const afterTheMove = view(familyWith({ status: 'archived' }), LIVE_CODE);
    expect(afterTheMove.held).toBe('stale');
  });

  it('never resurrects a stale code when the child is activated again (the latch)', () => {
    // The screen writes the rendered answer back into its own state, so `held` is 'stale' by the time
    // the profile is redeemable again. That must stay 'stale': the code itself was dropped and the
    // server has one live code per child, so there is nothing to bring back.
    const backAgain = view(familyWith({ status: 'active' }), 'stale');
    expect(backAgain.held).toBe('stale');
    // And the notice does not contradict the live Create button beside it.
    expect(backAgain.canCreate).toBe(true);
    expect(backAgain.staleNextStep).toMatch(/Riley is active again, so you can create a new code/);
  });

  it('holds nothing when nothing was minted, whatever the status', () => {
    for (const status of CHILD_PROFILE_STATUSES) {
      expect(view(familyWith({ status }), null).held).toBeNull();
    }
  });

  it('names the child from the live row, not the route param frozen at navigation', () => {
    const renamed = view(familyWith({ nickname: 'Riley B.' }), LIVE_CODE);
    expect(renamed.nickname).toBe('Riley B.');
    // The param is the fallback for a row that is gone, and nothing else.
    expect(view(familyWith({}), LIVE_CODE, GONE).nickname).toBe('your child');
  });
});

describe('the stale notice says only what this screen can establish (BUG-393, BUG-395)', () => {
  it('defers to the notices beside it for a child who cannot be brought back here', () => {
    // WEBR4-02: a deletion-pending child cannot be activated and the deletion cannot be undone from
    // the app, so the sentence may put the next code behind a CONDITION and may not presuppose the
    // condition will be met.
    const shown = view(familyWith({ deletionPending: true }), LIVE_CODE);
    expect(shown.staleNextStep).toMatch(/if Riley is active again/);
    expect(shown.staleNextStep).not.toMatch(/once Riley is active again/);
    expect(shown.staleNextStep).not.toMatch(/\byet\b/);
    // And it DEFERS: it points at what this screen is also showing — `pairingNote` above — instead of
    // asserting for itself whether the child can come back.
    expect(shown.staleNextStep).toMatch(/the notices above say whether that is possible/);
    expect(shown.pairingNote).not.toBeNull();
  });

  it('the redeemable-again sentence points at the control this screen is offering', () => {
    // The other state that reaches the notice. "above" is a claim about this screen's layout, and the
    // screen is ordered so it holds: the Create control is rendered before the panel.
    const shown = view(familyWith({ status: 'active' }), 'stale');
    expect(shown.staleNextStep).toMatch(/you can create a new code above/);
    expect(shown.canCreate).toBe(true);
    expect(shown.staleNextStep).not.toMatch(/is not active/);
  });

  it('never claims that being active is sufficient for the next code to work', () => {
    // BUG-395: the status is one of five conditions /pair checks. A consent withdrawal, a
    // provider-side consent flip and a code minted on another surface each retire a code with the
    // status untouched, and neither surface reads /v1/consent here.
    const sentence = [
      PAIRING_STALE_COPY.headline,
      PAIRING_STALE_COPY.reason,
      view(familyWith({ status: 'active' }), 'stale').staleNextStep,
      PAIRING_STALE_COPY.consentLead,
      PAIRING_STALE_COPY.consentTarget,
    ].join(' ');
    expect(sentence).toMatch(/can also stop working while a profile stays active/);
    expect(sentence).toMatch(/checked against your family’s consent too/);
    expect(sentence).not.toMatch(/will connect/);
  });

  it('is the SAME definition the portal prints, not a sentence that happens to match', () => {
    // BUG-410: a test that greps the other surface's source guards the WORDS and not the MEANING —
    // reverting a portal sentence once left the whole mobile suite green at 859/859. So this asserts
    // the shared export's own output, which is the only thing both surfaces can be reading.
    const child = { status: 'archived' } as const;
    expect(view(familyWith(child), LIVE_CODE).staleNextStep).toBe(
      pairingStaleNextStep(familyWith(child).children[0], 'Riley'),
    );
  });
});

describe('the Children screen and the pair-device screen answer with one predicate', () => {
  it('a row that says it can pair is a row the pair-device screen will mint for, and no other', () => {
    // `childRows.canPair` held its own `status === 'active'` copy, which omitted `deletionPending`;
    // the Children screen happened to guard that at the call site and this screen did not.
    for (const child of [
      { status: 'active' as const },
      { status: 'active' as const, deletionPending: true },
      { status: 'draft' as const },
      { status: 'archived' as const },
    ]) {
      const family = familyWith(child);
      const row = childRows(family).find((r) => r.id === RILEY);
      expect([child, row?.canPair]).toEqual([child, view(family, null).canCreate]);
    }
  });
});

/**
 * THE WIRING. `app/(parent)/pair-device.tsx` imports react-native and this suite is pure logic only
 * (apps/mobile/vitest.config.ts), so these read its source. They are not a substitute for the cases
 * above — a source pin guards the words, not the meaning (BUG-410) — they pin the one thing a pure
 * test cannot reach: that the screen asks the question at all, with the real state, and renders the
 * answer instead of what it is holding.
 */
describe('the screen hands the rule the real state and renders its answer', () => {
  const screen = readFileSync(
    join(import.meta.dirname, '..', '..', 'app', '(parent)', 'pair-device.tsx'),
    'utf8',
  );

  it('reads the child’s live status instead of trusting the route param', () => {
    expect(screen).toMatch(/familyOverviewResponseSchema/);
    expect(screen).toMatch(/api\.get\('\/v1\/family', familyOverviewResponseSchema\)/);
    expect(screen).toMatch(/pairDeviceView\(state\.data, childId, fallbackNickname, held\)/);
  });

  it('renders the decided answer, never the code it is holding', () => {
    // The defect in one line: `if (code) return …{code.code}`. What may be printed is the view's
    // answer; `held` is only what came back from the POST.
    expect(screen).toMatch(/const shown = view \? view\.held : held;/);
    expect(screen).toMatch(/\{shown === null \? null : shown === 'stale' \?/);
    expect(screen).toMatch(/\{shown\.code\}/);
    expect(screen).not.toMatch(/\{held\.code\}/);
  });

  it('re-reads the family when a code arrives, so the render deciding has the new status', () => {
    expect(screen).toMatch(/setHeld\(result\);\s*\n\s*await reload\(\);/);
  });

  it('latches the answer back into its own state, so a stale code stays stale', () => {
    expect(screen).toMatch(
      /useEffect\(\(\) => \{\s*\n\s*setHeld\(shown\);\s*\n\s*\}, \[shown\]\);/,
    );
  });

  it('offers the Create control only when the shared predicate says a code can be redeemed', () => {
    expect(screen).toMatch(/\{view\.canCreate \?/);
    expect(screen).not.toMatch(/status === 'active'/);
  });

  it('prints the stale notice from the shared copy, holding no wording of its own', () => {
    expect(screen).toMatch(/\{PAIRING_STALE_COPY\.headline\} \{PAIRING_STALE_COPY\.reason\}/);
    expect(screen).toMatch(/\{view\.staleNextStep\}/);
    expect(screen).toMatch(
      /\{PAIRING_STALE_COPY\.consentLead\} \{PAIRING_STALE_COPY\.consentTarget\}/,
    );
    // No literal copy of any shared sentence, which is what "delete the local copies" means here.
    expect(screen).not.toMatch(/can’t connect a device/);
    expect(screen).not.toMatch(/is active again, so you can create/);
  });

  it('puts the Create control ABOVE the notice, because the shared sentence says "above"', () => {
    expect(screen.indexOf('view.canCreate ?')).toBeGreaterThan(-1);
    expect(screen.indexOf('view.canCreate ?')).toBeLessThan(screen.indexOf('view.staleNextStep'));
  });
});

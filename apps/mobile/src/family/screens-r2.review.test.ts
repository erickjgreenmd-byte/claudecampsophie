import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { biometricOffer, BIOMETRIC_OWNER_KEY } from './unlock.ts';

/**
 * Mobile round-2 hardening of the screens (MOB-R2-01/04/05/06/07 and the mobile half of WEB-R2-02).
 * The Expo screens import react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read their source: each one names the control, the wiring or
 * the copy a screen must carry, so a refactor cannot quietly drop it.
 */
const appDir = join(import.meta.dirname, '..', '..', 'app');
const srcDir = join(import.meta.dirname, '..');
const screen = (...parts: string[]) => readFileSync(join(appDir, ...parts), 'utf8');
const ui = readFileSync(join(import.meta.dirname, 'ui.tsx'), 'utf8');
const runtime = readFileSync(join(import.meta.dirname, 'runtime.ts'), 'utf8');

describe('one lock action for backgrounding and both Lock buttons (MOB-R2-01)', () => {
  it('the shared Lock button runs the whole device lock, not only the server relock', () => {
    expect(ui).toMatch(/export function LockParentAreaButton/);
    expect(ui).toMatch(/lockParentAreaOnDevice\(secureStorage, modeEffects\)/);
  });

  it('the parent home and the unlock screen both use it instead of lockParentArea(api)', () => {
    expect(screen('(parent)', 'home.tsx')).toMatch(/<LockParentAreaButton \/>/);
    expect(screen('(parent)', 'home.tsx')).not.toMatch(/lockParentArea\(api\)/);
    expect(screen('(parent)', 'unlock.tsx')).toMatch(/<LockParentAreaButton \/>/);
    expect(screen('(parent)', 'unlock.tsx')).not.toMatch(/lockParentArea\(api\)\.then/);
  });

  it('the session layer locks the device on backgrounding, exempting an open purchase sheet', () => {
    const session = readFileSync(join(srcDir, 'lib', 'app-session.ts'), 'utf8');
    expect(session).toMatch(/if \(storePurchaseInFlight\(\)\) return;/);
    // The storage argument is what returns a paired family tablet to the child space (MOB-R4-LOCK-01).
    expect(session).toMatch(/await lockParentAreaOnDevice\(secureStorage, modeEffects\)/);
  });

  it('the plan screen marks its purchase so backgrounding does not lock mid-purchase', () => {
    expect(screen('(parent)', 'plan.tsx')).toMatch(
      /whileStorePurchaseOpen\(\s*\(\)\s*=>\s*runPlanChange\(/,
    );
  });

  it('the parent gate re-checks the unlock whenever the app comes back to the foreground', () => {
    expect(ui).toMatch(/next === 'active'/);
    // And the gate's check is a named, reusable function rather than a one-shot mount effect.
    expect(ui).toMatch(/const check = useCallback\(/);
  });

  /**
   * Source check (the vitest project cannot import react-native, so this hook has no rendered test):
   * each check must cancel the one before it. The foreground listener calls check() on every 'active',
   * so two checks could otherwise be in flight at once and the slower one would win the race to
   * setAccess — putting a screen back to 'ready' after a lock. Found as a residual by the round-3
   * acceptance checker; there is no failing reproduction because the hook cannot be rendered here.
   */
  it('each parent-gate check supersedes the one still in flight', () => {
    expect(ui).toMatch(/const cancelPrevious = useRef<\(\(\) => void\) \| null>\(null\)/);
    expect(ui).toMatch(/cancelPrevious\.current\?\.\(\);/);
    expect(ui).toMatch(/cancelPrevious\.current = cancel;/);
  });

  it('the runtime can reset navigation to the unlock screen', () => {
    expect(runtime).toMatch(/resetNavigationToUnlock\(\) \{/);
    expect(runtime).toMatch(/router\.replace\('\/\(parent\)\/unlock'\)/);
  });
});

describe('the unlock screen offers Sign out and Lock only past the PIN (MOB-R2-04)', () => {
  const unlock = screen('(parent)', 'unlock.tsx');

  it('both controls sit behind a live unlock, not beside the PIN field', () => {
    // The child's "Grown-ups" button opens this screen with no PIN, so an unconditional Sign out
    // let a child end the parent's session.
    expect(unlock).toMatch(/parentUnlockActive\(new Date\(\)\)/);
    expect(unlock).toMatch(/unlockActive \? \(/);
    expect(unlock).toMatch(/<SignOutButton \/>/);
  });

  it('a lapsed unlock window is reported, not a silent bounce back to the PIN', () => {
    expect(unlock).toMatch(/window_lapsed/);
    expect(unlock).toMatch(/unlockSeconds: outcome\.unlockSeconds/);
  });
});

describe('returning to a child screen re-enters child mode (MOB-R2-05)', () => {
  it('the child layout enters child mode when it regains focus in parent mode', () => {
    expect(ui).toMatch(/export function useChildModeOnFocus/);
    expect(ui).toMatch(/enterChildMode\(secureStorage, modeEffects\)/);
    expect(screen('(child)', '_layout.tsx')).toMatch(/useChildModeOnFocus\(\)/);
  });
});

describe('the biometric PIN never outlives its owner (MOB-R2-06)', () => {
  it('the stored PIN is offered only to the parent who stored it', () => {
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-a')).toBe('offer');
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-b')).toBe('other_user');
    // A PIN with no recorded owner (an older build): never offered, and removed.
    expect(biometricOffer({ enabled: true, ownerUserId: null }, 'user-a')).toBe('other_user');
    // "Nobody signed in" used to be folded into 'other_user' here, which made the unlock screen
    // delete the enrolment of the parent who IS signed in whenever the session could not be read
    // (MOB-R4-LOCK-02). It is its own outcome now; the assertion that pinned 'other_user' was wrong.
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, null)).toBe('unknown');
    expect(biometricOffer({ enabled: false, ownerUserId: 'user-a' }, 'user-a')).toBe('off');
  });

  it('the owner is stored beside the enabled flag', () => {
    expect(BIOMETRIC_OWNER_KEY).toBe('pl.parent.biometricOwner');
    expect(runtime).toMatch(/BIOMETRIC_OWNER_KEY/);
    expect(runtime).toMatch(/biometricOffer\(/);
  });

  it('signing out on the device clears the stored PIN', () => {
    // Both device exits go through the same helper, so neither can drop the PIN removal.
    expect(runtime).toMatch(
      /export async function signOutParentOnDevice[^]*?clearDeviceAdultSecrets\(\)/,
    );
    expect(runtime).toMatch(
      /async function clearDeviceAdultSecrets[^]*?biometricPinStore\.clear\(\)/,
    );
  });

  it('closing the account goes through the same device sign-out', () => {
    const privacy = screen('(parent)', 'privacy.tsx');
    // The whole device sign-out, so a closed account leaves no PIN, no parent mode and no unlock.
    // The call takes no argument (MOB-R4-LOCK-05): nothing at the call site can switch part of the
    // closure off, which is how the first round-4 attempt ended up inert.
    // The screen hands the shared device sign-out to the closure flow (HUNT6-J-2 moved the ordering
    // into src/privacy/parent-privacy.ts, where it is run in a test rather than grepped for here).
    expect(privacy).toMatch(
      /runAccountClosure\(api, closeConfirmed, signOutClosedAccountOnDevice,/,
    );
    expect(privacy).not.toMatch(/parentAuth\.signOut\(\)/);
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice[^]*?await signOutClosedAccount\(/,
    );
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice[^]*?clearDeviceAdultSecrets\(\)/,
    );
  });
});

/**
 * Round-4 hardening of the parent-area lock (MOB-R4-LOCK-02/03/04/05/06). Each check below names
 * the wiring or the copy that closes one finding, so a refactor cannot quietly drop it; the parts
 * that can be exercised as logic have real tests in src/lib/mode-r2.review.test.ts and
 * src/lib/app-session.test.ts.
 */
describe('the biometric enrolment survives a session that cannot be read (MOB-R4-LOCK-02)', () => {
  it('[repro] “nobody signed in” is its own outcome, not the same as a different parent', () => {
    // An offline device more than the access-token TTL past its last refresh reports no user id
    // (getSession() yields null once the token is expired and the refresh cannot run), so folding
    // that into 'other_user' deleted the keychain PIN of the parent who IS signed in.
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, null)).toBe('unknown');
    expect(biometricOffer({ enabled: true, ownerUserId: 'user-a' }, 'user-b')).toBe('other_user');
  });

  it('the runtime store deletes the stored PIN only for a different owner', () => {
    expect(runtime).toMatch(/if \(offer === 'other_user'\) \{\s*await clearBiometricPin\(\);/);
    // 'unknown' falls through to the plain `offer === 'offer'` answer: no offer, no delete.
    expect(runtime).toMatch(/return offer === 'offer';/);
  });
});

describe('no PIN-less visitor can change the parent’s security settings (MOB-R4-LOCK-03)', () => {
  const unlock = screen('(parent)', 'unlock.tsx');

  it('“Turn off biometric unlock” is behind the parental gate, not a bare button', () => {
    // It deletes the keychain PIN and both flags, with no PIN, no OS prompt and no confirmation,
    // and the child's "Grown-ups" button opens this screen with no PIN at all. The gate is the one
    // already used for the portal link here; the live-unlock condition that hides Lock and Sign out
    // would put it out of a parent's reach, since they arrive at this screen precisely without one.
    expect(unlock).toMatch(/<GatedButton\s+label="Turn off biometric unlock"/);
    expect(unlock).not.toMatch(/<Button\s+label="Turn off biometric unlock"/);
  });
});

describe('an auth change closes the client-side unlock (MOB-R4-LOCK-04)', () => {
  it('the session watcher forgets the unlock when the Supabase session disappears', () => {
    const session = readFileSync(join(srcDir, 'lib', 'app-session.ts'), 'utf8');
    expect(session).toMatch(/if \(!signedIn\) \{[^]*?forgetParentUnlock\(\)/);
  });

  it('the parent gate re-checks when a parent screen comes back into view', () => {
    // Without a re-check a screen that was already 'ready' kept the previous parent's data on
    // screen, and its ApiClient followed whoever signed in next: the finding's repro is the header
    // back arrow from the sign-in/unlock screen onto the still-mounted parent screen underneath,
    // which is a focus event. Focus is the trigger for it.
    //
    // The first round-4 attempt re-checked on parentAuth.watch instead. That assertion was wrong:
    // the watch fires during app/(parent)/privacy.tsx's own account closure (it calls
    // parentAuth.signOut()), and privacy.tsx renders its "Account deleted" confirmation inside the
    // `access.status === 'ready'` branch, so re-gating on that event replaced the confirmation the
    // parent had just earned with a sign-in prompt. The unlock is still forgotten on the auth
    // change (src/lib/app-session.ts, the check above), which is what closes the grant.
    expect(ui).toMatch(/useFocusEffect\(check\)/);
    expect(ui).not.toMatch(/parentAuth\.watch\(\(\) => check\(\)\)/);
  });

  it('a screen that is still unlocked keeps the access it already had — for the SAME adult', () => {
    // A check that is still 'ready' hands the screen back the SAME state object. parentApi() builds
    // a new ApiClient on every call, and the parent screens key their load on that client (e.g.
    // app/(parent)/home.tsx: useLoad(load) with load = useCallback(…, [api])), so a fresh object on
    // every focus would re-fetch and flash "Loading your family" over data the parent was already
    // reading each time they came back from a pushed screen.
    //
    // HUNT5-H-1: that reuse used to be unconditional, and the last sentence of this rationale used
    // to read "the client's token source reads the live session, so reusing it never serves another
    // parent's data" — which was the defect, not the guarantee. The token source does follow whoever
    // is signed in now, but the DATA already on the screen belongs to whoever fetched it: on a
    // handed-on tablet (A's Children screen mounted underneath, A's session ended, B signs in and
    // unlocks with B's own PIN, B taps the header back arrow) the re-check handed B A's children.
    // The state is reused only while it still belongs to the adult at the device: the gate records
    // parentIdentityGeneration() when it publishes 'ready', and the rule lives in src/lib/mode.ts
    // with behavioural tests in src/lib/mode-r2.review.test.ts and src/lib/app-session.test.ts.
    expect(ui).toMatch(/const readyIdentity = useRef<number \| null>\(null\)/);
    expect(ui).toMatch(
      /previous\.status === 'ready' && parentStateStillCurrent\(publishedUnder\)\s*\?\s*previous\s*:\s*\{ status: 'ready', api \}/,
    );
    expect(ui).toMatch(/readyIdentity\.current = identity;/);
  });

  it('[repro] the identity the updater compares is read BEFORE the setter, not inside it', () => {
    // The first HUNT5-H-1 fix read the ref INSIDE the updater — `parentStateStillCurrent(
    // readyIdentity.current)` — and overwrote `readyIdentity.current` on the very next line.
    // React's documented contract is that a state updater runs during the next render, i.e. AFTER
    // that overwrite, at which point the guard compares the new identity with itself, returns
    // `previous`, and hands parent B parent A's state: the one case the whole fix exists for. It
    // happened to work only because React can compute an update eagerly when a fiber's queue is
    // empty (an implementation detail, not a contract), and this check runs inside a promise
    // callback where a queued update is entirely ordinary. So the identity the screen's state was
    // published under is captured in a local first, the updater closes over that local, and only
    // then is the new identity recorded. This suite cannot render the hook (react-native, see the
    // file header), so the ordering is pinned at source level: the three statements must appear in
    // that order, and the updater must not reach for the ref at all.
    expect(ui).toMatch(
      /const publishedUnder = readyIdentity\.current;\s*setAccess\(\(previous\) =>[\s\S]*?parentStateStillCurrent\(publishedUnder\)[\s\S]*?readyIdentity\.current = identity;/,
    );
    expect(ui).not.toMatch(
      /setAccess\(\(previous\) =>[\s\S]*?parentStateStillCurrent\(readyIdentity\.current\)/,
    );
  });
});

describe('closing the account leaves no child pairing on the device (MOB-R4-LOCK-05)', () => {
  it('the closure is one call with nothing to switch off', () => {
    // The rule and its behavioural tests live in src/lib/mode.ts / src/lib/mode-r2.review.test.ts
    // ("closing an account leaves no child pairing on the device"): the closure signs the parent out
    // and then forgets the child on this device — refresh token, cached nickname, mode 'signed_out'.
    //
    // The first round-4 attempt put that forget behind a `familyDeleted` argument so a guardian's own
    // closure would keep the pairing, and left the single call site passing nothing: the fix never ran
    // on the finding's repro (the owner deletes the family, then closes their sign-in on the paired
    // tablet). Nothing on the device can tell the two closures apart, so the forget is unconditional
    // and purely local — no child session is revoked on the wire — and the signature has no argument
    // for a call site to omit.
    expect(runtime).toMatch(
      /export async function signOutClosedAccountOnDevice\(\): Promise<DeviceSignOutOutcome>/,
    );
    expect(runtime).not.toMatch(/familyDeleted: false/);
    expect(runtime).not.toMatch(/childSession\.logout\(\)/);
  });

  it('the child home offers a grown-up route while the device is not connected', () => {
    const home = screen('(child)', 'home.tsx');
    const notConnected = /if \(state\.status === 'not_connected'\) \{([^]*?)\n {2}\}/.exec(home);
    expect(notConnected).not.toBeNull();
    expect(notConnected?.[1]).toMatch(/label="Grown-ups"/);
  });
});

describe('the Children screen tells the truth about an open deletion (HUNT5-H-2, HUNT5-H-3)', () => {
  const children = screen('(parent)', 'children.tsx');
  /** Only the deletion notice: the rest of the screen has its own copy (e.g. "Cancel edit"). */
  const notice = /Data\s+deletion\s+under\s+way\.([^]*?)<\/Notice>/.exec(children)?.[1] ?? '';

  it('[repro] never promises a cancel, because nothing in PencilLift can cancel a deletion', () => {
    // MOB-R4-LOCK-06 rewrote this notice and ended it "Privacy shows exactly what you asked for, and
    // cancels it if you did not mean it". There is no cancel: apps/api/src/routes/privacy.ts exposes
    // only POST and GET /deletion, nothing sets deletion_requests.status = 'cancelled', and the
    // mobile Privacy screen says in so many words that deleting "can't be undone". A parent who
    // deleted the wrong child's data went looking for the cancel and burned the only window in which
    // support could still have stopped the purge, which is enqueued with the request itself. The web
    // client's identical claim was fixed in the same round (WEBR4-02 / BUG-221) and its suite makes
    // this same assertion (apps/web/src/pages/app/ChildrenPage.archive.test.tsx).
    expect(notice).not.toBe('');
    expect(notice).not.toMatch(/cancel/i);
    expect(notice).toMatch(/can’t\s+be\s+undone\s+from\s+the\s+app/);
    expect(notice).toMatch(/contact\s+support/i);
    expect(children).toMatch(/router\.push\('\/\(parent\)\/support'\)/);
  });

  it('says what is true of the only request this screen can show: it covers this child', () => {
    // HUNT5-H-3: the rewrite hedged that the deletion "may be for {nickname} alone or for your whole
    // family account", a state this screen cannot reach. A family-scope request revokes every adult
    // membership in the same transaction as the family tombstone
    // (supabase/migrations/0840_hardening_r1_db.sql), so currentFamilyId() answers NOT_FOUND, GET
    // /v1/family cannot answer for any adult of that family, and the screen renders its no-family
    // notice instead of a child card at all. Telling a parent who asked for one child that their
    // whole family account may be being deleted — and that the app cannot say which — was the most
    // alarming ambiguity on this screen.
    //
    // This comment used to end "The web client states the reachable truth
    // (apps/web/src/pages/app/ChildrenPage.tsx) and the two surfaces now agree", in the very test
    // whose job is to pin the sentence. It cannot say that. The assertions below read this app's
    // source and nothing else, so agreement between the surfaces is not something this file knows or
    // pins — and it was false as written, because the requester-neutral form below is the mobile half
    // of HUNT6-I-3 while the web client's identical claim is its other half, in another area's file
    // with its own suite (apps/web/src/pages/app/ChildrenPage.archive.test.tsx). What is true here is
    // that this screen says only what `deletionPending` carries.
    //
    // HUNT6-I-3: this assertion used to pin "You asked for {row.nickname}", which named the READER as
    // the requester — a fact `deletionPending` does not carry (the flag is computed from the request's
    // scope and target, the response never exposes requested_by, and any guardian may delete a
    // child's data, so the other adult is served the same flag). It pins the requester-neutral form
    // now, and children-screen.test.ts asserts the claim cannot come back.
    expect(notice).toMatch(/request\s+covering\s+\{row\.nickname\}/);
    expect(notice).not.toMatch(/whole\s+family/i);
    expect(notice).not.toMatch(/\byou\s+asked\b/i);
    expect(children).toMatch(/Data\s+deletion\s+under\s+way/);
  });
});

describe('a render error shows a retry screen instead of closing the app (MOB-R2-07)', () => {
  for (const layout of [['_layout.tsx'], ['(child)', '_layout.tsx'], ['(parent)', '_layout.tsx']]) {
    it(`app/${layout.join('/')} exports an ErrorBoundary`, () => {
      expect(screen(...layout)).toMatch(/export function ErrorBoundary\(/);
    });
  }

  it('the child copy is calm and leads home; the parent copy offers a retry', () => {
    expect(screen('(child)', '_layout.tsx')).toMatch(/Something went wrong\./);
    expect(screen('(child)', '_layout.tsx')).toMatch(/Let’s go back home\./);
    expect(ui).toMatch(/export function ErrorScreen/);
    expect(ui).toMatch(/label="Try again"/);
  });
});

describe('signing out of the phone leaves other sessions alone (WEB-R2-02, mobile half)', () => {
  it('the mobile parent sign-out is local to this device', () => {
    const auth = readFileSync(join(srcDir, 'lib', 'parent-auth.ts'), 'utf8');
    expect(auth).toMatch(/signOut\(\{ scope: 'local' \}\)/);
  });
});

/**
 * HUNT6-I-1. The HUNT5-H-1 fix rests on a premise about the screens — the gate publishes fresh state
 * for a moved parent identity, and "the screens key their load on the client", so fresh state is what
 * makes them refetch. One screen did not: the Practice planner ran its own loader whose effect
 * depended on a literal path string and a manual counter, so publishing fresh state changed nothing
 * there and the next adult kept the previous family's children, subjects and schedule with no request
 * made at all. That is L-037 in its purest form — verified on the one screen its test comment named
 * (app/(parent)/home.tsx, above) and assumed for the rest.
 *
 * So the premise is asserted rather than assumed, over EVERY parent screen: a hook that reads the
 * gate's client, or calls a loader closed over it, must list it, so a new client re-runs the load.
 * A screen added later cannot opt out silently.
 */
describe('every parent screen keys its loads on the client the gate published (HUNT6-I-1)', () => {
  const parentDir = join(appDir, '(parent)');
  const screens = readdirSync(parentDir).filter((name) => name.endsWith('.tsx'));

  /** Comments and quoted strings are not code: a `'load'` label or a "then load" comment is not a use. */
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  /**
   * Every `useCallback(…)`/`useEffect(…)` in a screen as {body, deps}, found by walking to the
   * matching close paren of the hook call, so a nested hook or a multi-line body is not mis-split.
   */
  function hooks(source: string): { body: string; deps: string | null }[] {
    const found: { body: string; deps: string | null }[] = [];
    const calls = /\buse(?:Callback|Effect)\(/g;
    for (let m = calls.exec(source); m !== null; m = calls.exec(source)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < source.length && depth > 0; i += 1) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
      }
      const call = source.slice(m.index + m[0].length, i - 1);
      // A trailing comma is prettier's, on a multi-line hook call; a hook whose dependency array
      // cannot be read reads as none, which FAILS the check below rather than excusing the screen.
      const deps = /,\s*(\[[^[\]]*\])\s*,?\s*$/.exec(call.trimEnd())?.[1] ?? null;
      found.push(
        deps === null
          ? { body: call, deps }
          : { body: call.slice(0, call.lastIndexOf(deps)), deps },
      );
    }
    return found;
  }

  const uses = (text: string, name: string) => new RegExp(`(?<![\\w.])${name}(?![\\w])`).test(text);

  it('[repro] no parent screen has a load hook that a new client cannot re-run', () => {
    const offenders: string[] = [];
    for (const name of screens) {
      const source = code(readFileSync(join(parentDir, name), 'utf8'));
      for (const hook of hooks(source)) {
        for (const dependency of ['api', 'load']) {
          if (uses(hook.body, dependency) && !uses(hook.deps ?? '', dependency)) {
            offenders.push(
              `${name}: a hook using \`${dependency}\` has deps ${hook.deps ?? '(none)'}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the screens really do go through the shared hook, so the check above has something to check', () => {
    // A guard over an empty set passes (L-054): at least one hook per data screen must be found, and
    // the shared loader must be the one they use.
    expect(screens.length).toBeGreaterThan(8);
    for (const name of ['children.tsx', 'home.tsx', 'planner.tsx', 'devices.tsx']) {
      expect(hooks(code(readFileSync(join(parentDir, name), 'utf8'))).length).toBeGreaterThan(0);
      expect(screen('(parent)', name)).toMatch(/useLoad\(/);
    }
  });
});

/**
 * HUNT6-I-1, the half its own fix introduced. Keying the planner's loads on the client makes the next
 * adult's rows arrive; it does not make the SELECTION follow. The screen remembered the child id the
 * parent tapped in a `useState` and set it once from an effect ("if it is null and a first child
 * exists"), so a load for a different family left that id in place — and with it in none of the new
 * family's children the screen fell out of every branch it has: no loading, no error, no
 * empty-family notice and no plan, which is a blank screen under the title for a family with one
 * child, and a <Choice> holding a value that is not one of its options for a family with more.
 *
 * A source pin, not a rendered test: app/(parent)/planner.tsx imports react-native, which this
 * project cannot load (see the file header). What is pinned is the shape that makes the invalid state
 * unreachable — the selection is computed from `children` on every render — and that each of the
 * screen's four states still renders something. The mutation that turns it red: put the remembered
 * pick back in the <Choice> and in the `children.find(…)`, which is the line the finding names.
 */
describe('the planner’s child selection is derived from the family it loaded (HUNT6-I-1)', () => {
  const planner = screen('(parent)', 'planner.tsx');

  it('[repro] the id the screen uses is computed from the loaded children, not remembered', () => {
    // `picked` is what the parent tapped; it reaches the screen only through this line, which admits
    // it only while the loaded family has that child and falls back to the family's first child.
    expect(planner).toMatch(
      /const childId = children\.some\(\(c\) => c\.id === picked\) \? picked : \(children\[0\]\?\.id \?\? null\);/,
    );
    // So the <Choice> holds one of its own options, and the plan resolves whenever there are children.
    expect(planner).toMatch(/value=\{childId\}/);
    expect(planner).toMatch(
      /const child = children\.find\(\(c\) => c\.id === childId\) \?\? null;/,
    );
    // The remembered pick itself never reaches the render: not as the Choice's value, and not as the
    // id the child is looked up by.
    expect(planner).not.toMatch(/value=\{picked\}/);
    expect(planner).not.toMatch(/children\.find\(\(c\) => c\.id === picked\)/);
    // And nothing sets it once and leaves it — the effect shape that survived the family change, and
    // any other writer than the parent's own tap (the <Choice> hands the setter over, it never calls
    // it), since a selection written anywhere else is a selection a load cannot re-derive.
    expect(planner).not.toMatch(/childId === null && firstChild !== null/);
    expect(planner).not.toMatch(/setPicked\(/);
  });

  it('every state of the load renders something, so no family can leave the screen blank', () => {
    // A guard over an empty set passes (L-054): these four are the only branches under the title, so
    // the check is that each one exists and that between them they cover idle/loading, error, ready
    // with no children, and ready with children — the last guaranteed by the derivation above.
    expect(planner).toMatch(
      /family\.state\.status === 'idle' \|\| family\.state\.status === 'loading' \? \(\s*<Loading/,
    );
    expect(planner).toMatch(/family\.state\.status === 'error' \? \(\s*<ErrorBox/);
    expect(planner).toMatch(
      /family\.state\.status === 'ready' && children\.length === 0 \? \(\s*<Notice/,
    );
    expect(planner).toMatch(/\{child && family\.state\.status === 'ready' \? \(\s*<ChildPlan/);
  });
});

/**
 * HUNT6-I-2. `useLoad` preserved a 'ready' state across a load it had never run, so the previous
 * adult's rows stayed on screen for the length of the new adult's request. The rule is a pure function
 * (src/family/family-view.ts `loadStateForRun`, tested in family-view.test.ts); what is pinned here is
 * the hook's wiring, which this suite cannot render.
 */
describe('useLoad drops rows produced by a different load (HUNT6-I-2)', () => {
  it('keeps the owning load in a ref and consults it through the shared rule', () => {
    expect(ui).toMatch(/const producedBy = useRef<\(\(\) => Promise<T>\) \| null>\(null\)/);
    expect(ui).toMatch(/loadStateForRun\(/);
    // And no longer the unconditional keep, which is what served one adult's rows to the next.
    expect(ui).not.toMatch(
      /setState\(\(s\) => \(s\.status === 'ready' \? s : \{ status: 'loading' \}\)\)/,
    );
  });

  it('[repro] the owning load is captured BEFORE the setter, not read inside the updater', () => {
    // The same mistake as the parent gate's first HUNT5-H-1 fix (pinned above): a state updater runs
    // during the next render, so an updater that read `producedBy.current` would read what the line
    // recording the new owner wrote and compare `load` with itself — it would keep the previous
    // adult's rows in exactly the case this exists for.
    expect(ui).toMatch(
      /const producer = producedBy\.current;\s*producedBy\.current = load;\s*setState\(\(s\) => loadStateForRun\(s, producer, load\)\);/,
    );
    expect(ui).not.toMatch(/loadStateForRun\(s, producedBy\.current/);
  });

  /**
   * [repro] The residual the HUNT6-I-2 prose overstated away: dropping the rows before the new fetch
   * is not the whole of it, because the ANSWER of the previous adult's request is still coming. The
   * hook awaited `load()` and published whatever resolved, so a request started for the PREVIOUS
   * client that settles after a newer load began put the previous adult's rows on screen as 'ready',
   * under the new adult's client — the same privacy harm, through the door the identity check does not
   * watch. It is reachable in the ordinary case, not a rare interleaving: the new load starts the
   * moment the gate publishes the new client, while the old request is still in flight.
   *
   * A source pin (react-native, see the file header). The mutation that turns it red is the line the
   * guard replaced: `setState({ status: 'ready', data: await load() })`, which is what the negative
   * below names.
   */
  it('[repro] an answer that arrives after a newer load began is dropped, not published', () => {
    expect(ui).toMatch(/const latestRun = useRef\(0\)/);
    // The ticket is taken before anything is awaited, and checked after — for the rows and for the
    // error alike, since publishing a superseded load's failure is the same lie about whose load it is.
    expect(ui).toMatch(/latestRun\.current \+= 1;\s*const ticket = latestRun\.current;/);
    expect(ui).toMatch(
      /const data = await load\(\);[\s\S]*?if \(latestRun\.current !== ticket\) return;\s*setState\(\{ status: 'ready', data \}\);/,
    );
    expect(ui).toMatch(
      /\} catch \(error\) \{\s*if \(latestRun\.current !== ticket\) return;\s*setState\(\{ status: 'error', error \}\);/,
    );
    // The unguarded publish itself: awaiting inside the setter leaves no place to check the ticket.
    expect(ui).not.toMatch(/setState\(\{ status: 'ready', data: await load\(\) \}\)/);
  });
});

/**
 * HUNT6-J-2's residual. The privacy screen is the one screen with its own loader, and its closure
 * guard was on the reload EFFECT only: pull-to-refresh calls `load` directly, so a pull during the
 * closure replaced the outcome with the ordinary screen — the whole "Delete my account" section back
 * on screen, second live button and all, in the middle of an operation of up to three network calls.
 * The claim being defended ("the section is off the screen for the length of the operation") had a
 * gesture-shaped exception, so the guard moved into `load`, where every door leads.
 *
 * A source pin (react-native, see the file header); the closure's own ordering is run as logic in
 * src/privacy/parent-privacy.test.ts. The mutation: move the check back out of `load`.
 */
describe('nothing puts the deleted account’s sections back on the screen (HUNT6-J-2)', () => {
  const privacy = screen('(parent)', 'privacy.tsx');

  it('[repro] `load` itself refuses once the closure has started, not just the reload effect', () => {
    const body = /const load = useCallback\(async \(\) => \{([^]*?)\n {2}\}, \[api\]\);/.exec(
      privacy,
    )?.[1];
    expect(body).toBeDefined();
    expect(body).toMatch(/if \(closureStarted\.current\) return;/);
    // And the closure cannot be overtaken by a load that was already in flight when it started, nor
    // by the previous adult's load (the same in-flight door as useLoad's, this loader's own copy).
    expect(body).toMatch(/const ticket = latestLoad\.current;/);
    expect(body).toMatch(
      /if \(latestLoad\.current !== ticket \|\| closureStarted\.current\) return;\s*setState\(\{ status: 'ready', data \}\);/,
    );
    expect(body).toMatch(
      /if \(latestLoad\.current !== ticket \|\| closureStarted\.current\) return;\s*setState\(\{ status: 'error'/,
    );
    // The effect keeps its own guard: it must not re-run the load at all on a new client mid-closure.
    expect(privacy).toMatch(/access\.status !== 'ready' \|\| closureStarted\.current/);
  });

  it('the pull-to-refresh gesture is not offered while the closure is the screen', () => {
    expect(privacy).toMatch(
      /api && state\.status !== 'closing' && state\.status !== 'account_closed' \? \(\s*<RefreshControl/,
    );
  });
});

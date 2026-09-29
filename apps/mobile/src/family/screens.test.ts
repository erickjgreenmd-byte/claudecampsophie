import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childPickerSuffix } from './family-view.ts';

/**
 * The Expo screens import react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read their source. They guard the mobile hardening round 1
 * fixes (MOB-R1-01/05/06/07/08/09/10): each one names the control or copy a screen must carry and
 * the wiring it must go through, so a refactor cannot quietly drop it.
 */
const appDir = join(import.meta.dirname, '..', '..', 'app');
const screen = (...parts: string[]) => readFileSync(join(appDir, ...parts), 'utf8');
const ui = readFileSync(join(import.meta.dirname, 'ui.tsx'), 'utf8');

describe('parent sign-out on the device (MOB-R1-01)', () => {
  it('the parent home and the unlock screen both offer Sign out', () => {
    expect(screen('(parent)', 'home.tsx')).toMatch(/<SignOutButton \/>/);
    expect(screen('(parent)', 'unlock.tsx')).toMatch(/<SignOutButton \/>/);
  });

  it('the sign-out button runs the full device sign-out, not a bare Supabase signOut', () => {
    expect(ui).toMatch(/signOutParentOnDevice\(\)/);
    const runtime = readFileSync(join(import.meta.dirname, 'runtime.ts'), 'utf8');
    // The effects became a parameter (defaulting to modeEffects) so account closure can reuse the
    // whole device sign-out without the navigation reset (MOB-R2-06); the wiring is unchanged.
    expect(runtime).toMatch(/signOutParentOnDevice\(\s*effects: ModeEffects = modeEffects,?\s*\)/);
    expect(runtime).toMatch(/signOutParent\(secureStorage, effects, parentAuth\)/);
    expect(runtime).toMatch(/forgetStoreIdentity\(\)/);
  });
});

describe('honest reminder copy (MOB-R1-05)', () => {
  const planner = screen('(parent)', 'planner.tsx');

  it('no longer offers reminder or quiet-hours toggles the app cannot honour', () => {
    expect(planner).not.toMatch(/Allow gentle practice reminders/);
    expect(planner).not.toMatch(/Quiet hours \(no reminders\)/);
    expect(planner).not.toMatch(/set\('childRemindersPermitted'/);
    expect(planner).not.toMatch(/set\('quietEnabled'/);
  });

  it('says reminders and quiet hours are not available yet', () => {
    expect(planner).toMatch(/reminders and quiet hours aren’t available yet/i);
    expect(planner).toMatch(/doesn’t send\s+notifications/);
  });

  it('keeps the schedule’s stored reminder fields (the API still carries them)', () => {
    const form = readFileSync(
      join(import.meta.dirname, '..', 'learning', 'planner-form.ts'),
      'utf8',
    );
    expect(form).toMatch(/childRemindersPermitted: form\.childRemindersPermitted/);
  });
});

describe('a stale pairing can always be replaced (MOB-R1-06)', () => {
  const pair = screen('pair.tsx');

  it('the “already connected” branch offers a different code through the child session’s own logout', () => {
    expect(pair).toMatch(/label=\{busy \? 'Disconnecting…' : 'Use a different code'\}/);
    expect(pair).toMatch(/await childSession\.logout\(\)/);
    expect(pair).toMatch(/setPairedName\(null\)/);
  });

  it('adds no second child token refresher (L-007)', () => {
    expect(pair).not.toMatch(/\/v1\/child\/refresh|refreshToken/);
  });
});

describe('a way home from every child screen (MOB-R1-07)', () => {
  it('the shared Screen renders the child nav when asked, with Home and Back controls', () => {
    expect(ui).toMatch(/export function ChildNav/);
    expect(ui).toMatch(/label="Home"/);
    expect(ui).toMatch(/label="Back"/);
    expect(ui).toMatch(
      /childNav \? \(\s*<>\s*<ChildNav back=\{childNav === 'home_and_back'\} \/>\s*\{content\}/,
    );
  });

  it('every child screen except the home carries the child nav', () => {
    for (const name of ['scan', 'results', 'rewards', 'help']) {
      expect(screen('(child)', `${name}.tsx`), name).toMatch(/<ChildNav( back=\{false\})? \/>/);
    }
    for (const name of ['practice', 'review']) {
      expect(screen('(child)', `${name}.tsx`), name).toMatch(
        /<Screen childNav="home(_and_back)?">/,
      );
    }
  });

  it('Home resets the child stack instead of pushing another home', () => {
    expect(ui).toMatch(
      /if \(router\.canDismiss\(\)\) router\.dismissAll\(\);\s*router\.replace\('\/\(child\)\/home'\)/,
    );
  });

  it('“All my scans” goes back to the list rather than stacking another one', () => {
    const results = screen('(child)', 'results.tsx');
    expect(results).toMatch(
      /label="All my scans" secondary onPress=\{\(\) => router\.dismissTo\('\/results'\)\}/,
    );
    expect(results).not.toMatch(/router\.push\('\/results'\)/);
  });
});

describe('a signed-out parent is offered the sign-in (MOB-R1-08)', () => {
  it('the unlock screen splits “nobody signed in” from “not configured in this build”', () => {
    const unlock = screen('(parent)', 'unlock.tsx');
    expect(unlock).toMatch(/parentAuth\.configured \? \(\s*<SignInPrompt \/>/);
    expect(unlock).toMatch(/isn’t connected in this build yet/);
    expect(unlock).not.toMatch(/isn’t connected on this device yet/);
  });

  it('the shared gate does the same, and the prompt leads to the sign-in screen', () => {
    expect(ui).toMatch(/parentAuth\.configured \? 'no_session' : 'not_configured'/);
    expect(ui).toMatch(
      /label="Sign in as a parent" onPress=\{\(\) => router\.replace\('\/\(parent\)\/sign-in'\)\}/,
    );
    // The sign-in screen continues to the PIN unlock, so the parent lands where they started.
    expect(screen('(parent)', 'sign-in.tsx')).toMatch(
      /if \(result\.ok\) router\.replace\('\/\(parent\)\/unlock'\)/,
    );
  });
});

describe('parent screens need the PIN after a restart (MOB-R1-09)', () => {
  it('the shared gate requires the in-memory unlock and sends a locked device to the unlock screen', () => {
    expect(ui).toMatch(
      /if \(!parentUnlockActive\(new Date\(\)\)\) \{\s*setAccess\(\{ status: 'locked' \}\);\s*router\.replace\('\/\(parent\)\/unlock'\)/,
    );
  });

  it('the unlock screen records the server’s unlock window', () => {
    expect(screen('(parent)', 'unlock.tsx')).toMatch(/unlockedUntil: outcome\.unlockedUntil/);
  });

  it('the parent privacy screen goes through the same gate and loads nothing before it opens', () => {
    const privacy = screen('(parent)', 'privacy.tsx');
    expect(privacy).toMatch(/const access = useParentAccess\(\)/);
    // The load is gated on the OPEN parent area, and the effect leaves early otherwise, so nothing
    // is fetched before the PIN. It also drops what is on screen before the fetch when `load` changes
    // identity, i.e. when a new client belongs to a new adult (HUNT6-I-2).
    expect(privacy).toMatch(
      /if \(access\.status !== 'ready' \|\| closureStarted\.current\) return;/,
    );
    expect(privacy).toMatch(
      /setState\(api \? \{ status: 'loading' \} : \{ status: 'not_connected' \}\);\s*void load\(\);/,
    );
    expect(privacy).toMatch(
      /if \(access\.status !== 'ready'\) \{\s*return \([^]*?<ParentAccessState access=\{access\} \/>/,
    );
  });

  /**
   * HUNT7-J-7. The privacy screen's own loader takes a ticket so that "a load superseded while its
   * request was in flight publishes nothing" — but it took it AFTER the `!api` return, so a run that
   * found no client set 'not_connected' while leaving the ticket pointing at the PREVIOUS run. An
   * earlier load still in flight then satisfied the ticket check and published `{status:'ready'}` over
   * that honest state: on a device whose parent session has just been revoked elsewhere (the portal's
   * "sign out everywhere", a password change), the signed-out family's children, exports and safety
   * reports repainted, because the gate deliberately does not re-check on `parentAuth.watch`. The
   * ticket is taken first now, as `useLoad` takes it before anything can be awaited.
   */
  it('[repro] the privacy screen takes its load ticket before either early return', () => {
    const privacy = screen('(parent)', 'privacy.tsx');
    const body =
      /const load = useCallback\(async \(\) => \{([^]*?)\n {2}\}, \[api\]\);/.exec(privacy)?.[1] ??
      '';
    expect(body).not.toBe('');
    const at = (needle: string) => {
      const index = body.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const bump = at('latestLoad.current += 1;');
    const ticket = at('const ticket = latestLoad.current;');
    expect(ticket).toBeGreaterThan(bump);
    // Every entry into `load` supersedes what is in flight, including the two that publish nothing.
    expect(ticket).toBeLessThan(at('if (closureStarted.current) return;'));
    expect(ticket).toBeLessThan(at('if (!api) {'));
  });

  it('the welcome screen sends a paired device into child mode explicitly', () => {
    const welcome = screen('index.tsx');
    expect(welcome).toMatch(
      /if \(route === '\/\(child\)\/home'\) \{\s*[^]*?await enterChildMode\(secureStorage, modeEffects\)/,
    );
  });
});

describe('the deletion warning names this build’s store (MOB-R1-10)', () => {
  const privacy = screen('(parent)', 'privacy.tsx');

  it('uses the build’s store channel and label, Amazon Appstore included', () => {
    expect(privacy).toMatch(/storeChannelForBuild\(\)/);
    expect(privacy).toMatch(/STORE_LABEL\[channel\]/);
    expect(privacy).not.toMatch(/does not cancel an App Store or Google Play\s+subscription/);
  });

  it('a build for no store names all three stores rather than guessing one', () => {
    expect(privacy).toMatch(/App Store, Google Play or Amazon Appstore subscription/);
  });
});

/**
 * HUNT6-H-1, mobile half. Every write control on the planner must be gated on the child's status, or
 * the parent who archived a child to free a paid slot edits their practice plan, presses Save and is
 * refused 422 CHILD_ARCHIVED with nothing kept. The rule itself is `childPlanEditable`
 * (src/family/family-view.ts), tested there; this pins that the screen goes through it.
 */
describe('the planner offers no write an archived child cannot take (HUNT6-H-1)', () => {
  const planner = screen('(parent)', 'planner.tsx');

  it('[repro] the subject toggle and the schedule save are behind the status', () => {
    expect(planner).toMatch(/const editable = childPlanEditable\(child\.status\)/);
    // The PATCH's own control: no Switch for a child whose subjects the API refuses to change.
    expect(planner).toMatch(/editable \? \(\s*<Switch/);
    // And the PUT's: no "Save schedule" button at all.
    expect(planner).toMatch(/if \(!editable\) \{/);
    expect(planner).toMatch(
      /editable \? \(\s*<Button\s+label=\{busy \? 'Saving…' : 'Save schedule'\}/,
    );
  });

  it('says why, and points at the screen that can change it back', () => {
    expect(planner).toMatch(/archived/i);
    expect(planner).toMatch(/in Children/);
  });
});

/**
 * HUNT7-J-2. `ownedChild` (apps/api/src/routes/learning.ts) excludes a child covered by a
 * requested/processing deletion request from BOTH access modes and throws NOT_FOUND before the archived
 * check, so GET /v1/children/:id/subjects and GET /v1/children/:id/learning-schedule both answer 404
 * for them — while GET /v1/family deliberately still lists the child, so this screen selects them by
 * default in a one-child family. The screen had no branch for it: `request_deletion` archives the child
 * (migration 0890), so the parent was told the plan "is read-only. Everything below is what was
 * planned", told to "make them active again in Children" — an activation the Children screen and the
 * API both refuse — and then told twice that the child "was not found. Pull to refresh.", on a screen
 * whose <Screen> ScrollView has no RefreshControl. The web planner has had this branch since round 5
 * (HUNT5-F-2).
 */
describe('the planner says nothing false about a child being deleted (HUNT7-J-2)', () => {
  const planner = screen('(parent)', 'planner.tsx');
  const at = (needle: string) => {
    const index = planner.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('[repro] branches on the flag before it computes editability or loads anything', () => {
    // The branch is in a wrapper with no hooks of its own, so a family reload that flips the flag for
    // the child on screen swaps components instead of changing how many hooks a render runs.
    expect(planner).toMatch(
      /if \(child\.deletionPending === true\) \{\s*return <DeletionPendingPlan/,
    );
    expect(at('child.deletionPending === true')).toBeLessThan(
      at('const editable = childPlanEditable(child.status)'),
    );
    expect(at('child.deletionPending === true')).toBeLessThan(at('useLoad(loadSchedule)'));
    // And the notice component itself asks the API for nothing.
    const notice =
      /function DeletionPendingPlan\(\{[^}]*\}: \{[^}]*\}\) \{([\s\S]*?)\n\}/.exec(planner)?.[1] ??
      '';
    expect(notice).not.toBe('');
    expect(notice).not.toMatch(/useLoad|api\.(get|send)/);
    // The Children screen's words, so the two surfaces say the same thing about the same flag, and the
    // requester-neutral form HUNT6-I-3 settled on ("covering", never "you asked for").
    expect(notice).toMatch(/Data deletion under way/);
    expect(notice).toMatch(/request covering \{nickname\}/);
    expect(notice).not.toMatch(/\byou asked\b/i);
    expect(notice).not.toMatch(/read-only|was planned|active again/i);
    expect(notice).not.toMatch(/pull to refresh/i);
    // …and the two routes that can actually help, as on the Children screen.
    expect(notice).toMatch(/router\.push\('\/\(parent\)\/privacy'\)/);
    expect(notice).toMatch(/router\.push\('\/\(parent\)\/support'\)/);
  });

  it('names the state in the child picker, so it is known before the plan is opened', () => {
    expect(planner).toMatch(/childPickerSuffix\(c\)/);
    // The rule itself is pure (src/family/family-view.ts). It lives with the other view models rather
    // than beside this screen, so its cases are asserted here, where the finding that asked for it is.
    expect(childPickerSuffix({ status: 'archived', deletionPending: true })).toBe(
      ' (data deletion under way)',
    );
    // The flag is tested first: request_deletion archives a child-scope target (migration 0890), so
    // such a child reads as archived too, and "archived" is the more comforting of the two words.
    expect(childPickerSuffix({ status: 'archived' })).toBe(' (archived — plan is read-only)');
    expect(childPickerSuffix({ status: 'draft' })).toBe(' (no paid slot)');
    expect(childPickerSuffix({ status: 'active' })).toBe('');
    expect(childPickerSuffix({ status: 'active', deletionPending: true })).toBe(
      ' (data deletion under way)',
    );
  });
});

/**
 * HUNT7-J-3. The archived read-only view renders "Coming up" first, and those values are computed live
 * by the API for an archived profile too: `dailyPracticeState` and `nextReviewReleases` never look at
 * the status (apps/api/src/routes/learning.ts), so the parent read "Today's daily practice is
 * available." and "Mathematics: Thu 16:00 (weekly review)" for a child whose sessions and devices were
 * revoked when they were archived (apps/api/src/routes/family.ts). "Everything below is what was
 * planned" does not cover a heading about the future: HUNT5-F-10 judged the same hedge insufficient on
 * the web planner and added the two halves this notice now carries.
 */
describe('the archived planner promises no practice an archived child gets (HUNT7-J-3)', () => {
  const planner = screen('(parent)', 'planner.tsx');
  /**
   * The archived branch's own copy: comments stripped, because a comment recording the sentence that
   * was wrong is not copy, and folded onto one line, because a sentence broken across two JSX lines
   * would otherwise slip past every match below.
   */
  const notice = (/\{editable \? null : \(([\s\S]*?)\n {6}\)\}/.exec(planner)?.[1] ?? '')
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  it('[repro] says no new practice is prepared, and that the times are conditional', () => {
    expect(notice).not.toBe('');
    expect(notice).toMatch(/no new practice is prepared or released/i);
    expect(notice).toMatch(/would produce if the profile were active again/i);
    // The claim the web client removed for the same reason: the times below contradict it.
    expect(notice).not.toMatch(/Everything below is what was planned/i);
  });

  it('names the condition on the activation it points at', () => {
    // `childRows` only offers activation while `unusedPaidSlots(family) > 0` (src/family/family-view.ts),
    // so "make them active again in Children" full stop sent the parent to a control that may not be
    // there.
    expect(notice).toMatch(/in Children/);
    expect(notice).toMatch(/while a paid slot is free/i);
  });
});

/**
 * HUNT7-J-6. `onChanged` reloads the schedule after a subject toggle so the releases follow, and the
 * reload could not reach the screen: `ScheduleEditor` seeded `const [latest, setLatest] = useState(initial)`
 * once and had no key, so React reused the instance and ignored the new prop. `nextReviewReleases` is
 * computed from the child's ENABLED subjects, i.e. it is exactly the field that toggle changes — the
 * parent turned Mathematics off and went on being shown its next weekly review, and the GET was spent
 * for nothing. Only a save updated it, through `setLatest(saved)`.
 */
describe('the planner’s Coming up card follows the schedule it loaded (HUNT7-J-6)', () => {
  const planner = screen('(parent)', 'planner.tsx');

  it('[repro] the card is built from the loaded schedule, not from the editor’s captured copy', () => {
    expect(planner).toMatch(/<ComingUp data=\{schedule\.state\.data\}/);
    expect(planner).not.toMatch(/buildUpcomingView\(latest/);
    // The editor keeps `latest` for the form and the zone only, and a save re-reads the schedule so the
    // card follows that too.
    expect(planner).toMatch(/onSaved: \(\) => void|onSaved\(\)/);
    expect(planner).toMatch(/onSaved=\{\(\) => void schedule\.reload\(\)\}/);
  });
});

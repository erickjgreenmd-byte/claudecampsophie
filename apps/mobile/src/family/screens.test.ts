import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(runtime).toMatch(/signOutParent\(secureStorage, modeEffects, parentAuth\)/);
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
    expect(privacy).toMatch(/if \(access\.status === 'ready'\) void load\(\)/);
    expect(privacy).toMatch(
      /if \(access\.status !== 'ready'\) \{\s*return \([^]*?<ParentAccessState access=\{access\} \/>/,
    );
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

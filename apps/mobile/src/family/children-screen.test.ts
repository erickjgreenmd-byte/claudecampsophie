import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WEB-R2-03 (mobile half): the Children screen offered only "Pair a device" and "Assign an unused
 * paid slot". Nothing could correct a child's grade, nickname or age band — the grade is what
 * practice generation is pitched at, so every family stayed on last year's grade once the school
 * year rolled over — and nothing archived a child, although the Plan screen tells parents "To stop
 * a child's paid features sooner, archive them in Children".
 *
 * The Expo screens import react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read the screen's source: each one names the control and the
 * wiring it must go through, so a refactor cannot quietly drop it.
 */
const children = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(parent)', 'children.tsx'),
  'utf8',
);
const plan = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(parent)', 'plan.tsx'),
  'utf8',
);
/**
 * The parent home renders the same `childRows` view model as the Children screen, so it is read here
 * too: HUNT7-G-3/HUNT7-J-1 is a defect that reached the parent through BOTH printers, and a check of
 * one of them would have passed while the other one lied.
 */
const home = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(parent)', 'home.tsx'),
  'utf8',
);
/**
 * The portal card the phone card was written from, read the way
 * src/family/consent-attestation.test.ts reads it: the point of these checks is that the wiring
 * exists on BOTH surfaces, which a test of one surface cannot show (L-037).
 */
const portal = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'web', 'src', 'pages', 'app', 'ChildrenPage.tsx'),
  'utf8',
);
/** The one view model both parent screens print from. */
const view = readFileSync(join(import.meta.dirname, 'family-view.ts'), 'utf8');

describe('editing a child profile on the Children screen (WEB-R2-03)', () => {
  it('sends PATCH /v1/children/:id through the contract response schema', () => {
    expect(children).toMatch(/'PATCH',\s*`\/v1\/children\/\$\{row\.id\}`/);
    expect(children).toMatch(/updateChildProfileResponseSchema/);
  });

  it('offers an Edit control with the nickname, grade and age-band fields', () => {
    expect(children).toMatch(/label=\{editing \? 'Cancel edit' : 'Edit profile'\}/);
    expect(children).toMatch(/accessibilityLabel=\{`Edit \$\{row\.nickname\}/);
    // The grade and age-band menus come from the contract, not a second hand-written list (L-036).
    expect(children).toMatch(/ageBandSchema\.options/);
    expect(children).toMatch(/GRADE_LEVEL_MAX/);
  });

  it('says the saved grade is what new practice is built for', () => {
    expect(children).toMatch(/new practice is built for the grade saved here/i);
  });
});

describe('archiving a child on the Children screen (WEB-R2-03)', () => {
  it('calls the archive route, which previously had no caller anywhere', () => {
    expect(children).toMatch(/'POST',\s*`\/v1\/children\/\$\{row\.id\}\/archive`/);
    expect(children).toMatch(/childArchiveResponseSchema/);
  });

  it('confirms first and says history is kept and the slot freed', () => {
    expect(children).toMatch(/confirmArchive/);
    // HUNT7-G-4 (WEBR4-12, mobile half): the label is no longer a literal here — it is decided by
    // `childArchiveLabel` in src/family/family-view.ts, which says "frees the slot" only for an
    // active child, because this row is rendered for a draft that holds none. The two labels
    // themselves are pinned behaviourally in src/family/family-view.test.ts.
    expect(children).toMatch(/label=\{childArchiveLabel\(child\.status\)\}/);
    expect(children).toMatch(/Yes, archive/);
    // JSX text wraps across source lines, so whitespace is matched loosely.
    expect(children).toMatch(/store\s+subscription\s+is\s+unchanged/i);
  });

  it('honours the Plan screen’s promise that archiving happens in Children', () => {
    expect(plan).toMatch(/archive them in Children/);
  });
});

describe('a deletion-pending child on the Children screen (ACC-FAM-03)', () => {
  /**
   * GET /v1/family keeps a child whose data deletion is `requested`/`processing` in its list and
   * flags it with `deletionPending`: the privacy screens resolve the nickname out of that list for
   * the pending-deletion list, the child's export rows and any safety report about it, so hiding the
   * row would break the only consumer of that lookup (L-042). The API refuses pairing, activation
   * and edits for such a child, so this screen must say so and offer no control that would only
   * dead-end.
   *
   * This rationale used to give "the request is still cancellable" as one of those reasons. There is
   * no cancel: apps/api/src/routes/privacy.ts exposes only POST and GET /deletion and nothing
   * anywhere sets deletion_requests.status = 'cancelled'. The same false promise was removed from
   * this screen's own copy (HUNT5-H-2) and from the portal's (BUG-221) — a parent who deleted the
   * wrong child's data went looking for the cancel instead of contacting support, which is the only
   * thing that could still have stopped the purge. The negative assertion below is what keeps the
   * claim from coming back through this file: prose is not checked, so the check is stated as a test.
   */
  it('reads the flag and says a data deletion is under way', () => {
    expect(children).toMatch(/const deletionPending = child\.deletionPending === true;/);
    expect(children).toMatch(/Data\s+deletion\s+under\s+way/i);
  });

  it('promises the parent no cancel, and names what they can actually do', () => {
    // Scoped to the deletion notice, because the rest of the screen says "Cancel edit" legitimately.
    // The portal suite asserts the same thing for the web copy
    // (apps/web/src/pages/app/ChildrenPage.archive.test.tsx, [WEBR4-02]), and
    // src/family/screens-r2.review.test.ts pins the wording this notice carries instead.
    const notice = /Data\s+deletion\s+under\s+way\.([\s\S]*?)<\/Notice>/.exec(children)?.[1] ?? '';
    expect(notice).not.toBe('');
    expect(notice).not.toMatch(/cancel/i);
    expect(notice).toMatch(/can’t\s+be\s+undone\s+from\s+the\s+app/);
    expect(notice).toMatch(/contact\s+support/i);
  });

  it('[repro] does not tell the reader that THEY asked for the deletion (HUNT6-I-3)', () => {
    // `deletionPending` carries no requester: GET /v1/family computes it as "a requested/processing
    // request whose scope is family OR whose target is this child" (apps/api/src/routes/family.ts),
    // with no reference to the caller, and the response never exposes deletion_requests.requested_by.
    // Any guardian may delete a child's data (apps/api/src/routes/privacy.ts) and a child-scope
    // request leaves every other membership active (supabase/migrations/0840_hardening_r1_db.sql), so
    // the family's OTHER adult is served the same flag — and was told, on the most alarming notice
    // this screen carries, that they had asked for it. The sentence must be true of any adult who
    // can see it.
    const notice = /Data\s+deletion\s+under\s+way\.([\s\S]*?)<\/Notice>/.exec(children)?.[1] ?? '';
    expect(notice).not.toBe('');
    expect(notice).not.toMatch(/\byou\s+asked\b/i);
    expect(notice).not.toMatch(/\byour\s+request\b/i);
    // And still names the child it covers, which is why the row stays listed at all.
    expect(notice).toMatch(/\{row\.nickname\}/);
  });

  it('offers no pairing, activation, edit or archive control for that child', () => {
    expect(children).toMatch(/\{deletionPending \? null : row\.canPair \?/);
    expect(children).toMatch(/\{deletionPending \? null : row\.canActivate \?/);
    expect(children).toMatch(/child\.status === 'archived' \|\| deletionPending \? null :/);
  });
});

/**
 * HUNT7-G-3 / HUNT7-J-1 (the source pin the finding asks for). The sentence a parent reads about a
 * deletion-pending child must come from the ONE helper both parent screens print from, so that
 * correcting it once corrects it everywhere — the claim HUNT6-G-2 made for the portal
 * (apps/web/src/pages/app/ChildrenPage.tsx `childStatusLabel`) and did not carry to the phone.
 *
 * The behaviour of the helper is pinned in src/family/family-view.test.ts. What is checked HERE is
 * what that suite cannot see: that neither screen holds status copy of its own, and that both take
 * their rows from `childRows`. The home screen is the sharper of the two — `grep -n deletion
 * home.tsx` finds nothing, so it renders no counter-notice at all and the status line is the parent's
 * only word on the matter.
 */
describe('neither parent screen can print “history only” for a deletion-pending child (HUNT7-G-3)', () => {
  it('[repro] the phone helper reads the flag in the same statement as the portal helper', () => {
    // L-037: one wording per state across the surfaces. The portal's `childStatusLabel` answers
    // 'Data deletion under way' before its status switch; the phone's `childStatusText` must decide
    // it the same way, in the helper both screens print from. family-view.test.ts asserts the
    // resulting sentence behaviourally; this is the pin that the DECISION is the portal's, not a
    // second one that can drift again.
    expect(portal).toMatch(
      /if \(child\.deletionPending === true\) return 'Data deletion under way';/,
    );
    expect(view).toMatch(
      /if \(child\.deletionPending === true\) return 'Data deletion under way';/,
    );
  });

  it('both screens print that one helper’s sentence and hold no status copy of their own', () => {
    expect(children).toMatch(/Status: \{row\.statusText\}/);
    expect(home).toMatch(/Status: \{row\.statusText\}/);
    expect(children).toMatch(/childRows\(family\)/);
    expect(home).toMatch(/childRows\(family\)/);
    // The false sentence exists in exactly one place in the app — the helper's archived branch — so
    // neither screen can reach it except through the flag-first helper above.
    expect(children).not.toMatch(/history only/i);
    expect(home).not.toMatch(/history only/i);
  });
});

/**
 * HUNT7-G-4. The phone form seeded all three fields from the live prop once and PATCHed all three
 * unconditionally, so a nickname fix reverted the other guardian's grade — BUG-222/WEBR4-03 three
 * rounds after the portal was fixed. The rule the body hangs on is pure and pinned in
 * src/family/family-view.test.ts (`childEditBody`); what is checked here is the wiring this suite
 * cannot render: every field marks itself touched, the body comes from the helper, Save is off until
 * something is edited, and the fields are NOT reseeded from the live prop (that is BUG-330).
 */
describe('the phone child form sends only what the parent edited (HUNT7-G-4)', () => {
  it('[repro] builds the PATCH body with the touched-fields helper, not from the seed', () => {
    expect(children).toMatch(/childEditBody\(/);
    // The old body: all three fields, unconditionally, from a mount-time snapshot.
    expect(children).not.toMatch(
      /onSave\(\{\s*nickname: name,\s*gradeLevel: Number\(grade\),\s*ageBand\s*\}\)/,
    );
  });

  it('marks each of the three fields touched from its own handler', () => {
    for (const field of ['nickname', 'gradeLevel', 'ageBand']) {
      expect(children).toContain(`...t, ${field}: true`);
    }
  });

  it('keeps Save off until something is edited, so reopening it cannot revert anything', () => {
    expect(children).toMatch(/nothingEdited/);
    expect(children).toMatch(/disabled=\{nothingEdited\}/);
  });

  it('seeds the fields once and never reseeds them from the live prop (BUG-330)', () => {
    // HUNT5-F-1's fix, kept: `seed` is captured with useState and the fields come from it. A
    // useEffect that pushed `child` back into the fields would put the other guardian's value under
    // the parent's hands mid-edit, which is the defect that fix was filed for.
    expect(children).toMatch(/const \[seed\] = useState\(child\);/);
    expect(children).toMatch(/useState\(seed\.nickname\)/);
    expect(children).not.toMatch(/useEffect\(\(\) => \{\s*setNickname/);
  });

  it('tells the parent what changed under the open form, naming no actor (HUNT7-G-2)', () => {
    expect(children).toMatch(/childEditDriftNote\(seed, child\)/);
    expect(children).not.toMatch(/another guardian/i);
  });

  it('is the rule the portal form already had, so the two surfaces decide alike', () => {
    // apps/web/src/pages/app/ChildrenPage.tsx EditChildForm: `touched` decides the body and
    // `nothingEdited` the button. The phone now hangs on the same two names.
    expect(portal).toMatch(
      /const \[touched, setTouched\] = useState\(\{ nickname: false, gradeLevel: false, ageBand: false \}\);/,
    );
    expect(children).toMatch(
      /const \[touched, setTouched\] = useState\(\{ nickname: false, gradeLevel: false, ageBand: false \}\);/,
    );
  });
});

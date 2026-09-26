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
    expect(children).toMatch(/Archive \(keeps history, frees the slot\)/);
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

  it('offers no pairing, activation, edit or archive control for that child', () => {
    expect(children).toMatch(/\{deletionPending \? null : row\.canPair \?/);
    expect(children).toMatch(/\{deletionPending \? null : row\.canActivate \?/);
    expect(children).toMatch(/child\.status === 'archived' \|\| deletionPending \? null :/);
  });
});

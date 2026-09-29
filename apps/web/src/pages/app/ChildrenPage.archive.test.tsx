import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ChildrenPage from './ChildrenPage.tsx';

/**
 * Round-4 hardening of the WEB-R2-03 archive/edit flow on the Children page. Synthetic names only.
 *
 *  - WEBR4-01 the archive confirmation promises "You can activate them again later while a paid
 *    slot is free", but an archived card rendered no control at all, so no client could call
 *    POST /v1/children/:id/activate for an archived profile (the API allows it and clears
 *    archived_at). Archiving signed the child's devices out, so the family lost that child with no
 *    in-product way back.
 *  - WEBR4-02 the deletion-pending notice sent the parent to the privacy page to "cancel the
 *    request"; there is no cancel anywhere (privacy.ts exposes only POST/GET /deletion and nothing
 *    sets deletion_requests.status = 'cancelled').
 *  - WEBR4-03 the edit form always sent nickname + gradeLevel + ageBand, so a nickname-only save
 *    reverted the other guardian's grade change — the opposite of the form's own doc comment.
 *  - WEBR4-12 the archive button promised to free a slot on a draft child that holds none, and a
 *    STEP_UP_REQUIRED refusal closed the very confirmation the inline PIN prompt tells the parent
 *    to press again.
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function overview(children: FamilyOverview['children'], paidSlots: number): FamilyOverview {
  return {
    id: FAMILY,
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots,
    billingConflict: null,
    managingChannel: 'app_store',
    children,
  };
}

/**
 * `later` is what GET /v1/family answers from the second call on, so a reload can move a row under a
 * form the parent already has open (HUNT5-F-1, HUNT5-F-3).
 */
function fakeApi(
  data: FamilyOverview,
  options: { sendFails?: () => ApiRequestError; later?: FamilyOverview } = {},
): { api: Partial<ApiClient>; sends: Call[] } {
  const sends: Call[] = [];
  let gets = 0;
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(_path: string, schema: S) => {
      gets += 1;
      return Promise.resolve(schema.parse(gets > 1 ? (options.later ?? data) : data));
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      if (options.sendFails) return Promise.reject(options.sendFails());
      const value = path.endsWith('/activate')
        ? { childId: RILEY, status: 'active', paidSlots: 1, assignedSlots: 1 }
        : path.endsWith('/archive')
          ? {
              childId: RILEY,
              status: 'archived',
              paidSlots: 1,
              assignedSlots: 0,
              note: 'Your store subscription is unchanged.',
            }
          : path === '/v1/children'
            ? { childId: SAM, status: 'draft' }
            : {
                child: {
                  id: RILEY,
                  nickname: nicknameOf(body),
                  gradeLevel: 3,
                  ageBand: '8-10',
                  status: 'active',
                },
              };
      // HUNT5-F-11: parsed the way the production client parses, with no fallback. This used to
      // resolve an unvalidated fixture when safeParse failed, cast to the contract's type, so a
      // response fixture that drifted from packages/contracts/src/family.ts kept these tests green
      // while the real page (contracts/src/client.ts throws on a failed parse) would have rejected
      // the response or rendered `undefined` in its success message. The `get` above always parsed.
      return Promise.resolve(schema.parse(value));
    },
  };
  return { api, sends };
}

/** The nickname the PATCH asked for, or the unchanged one when the body left it out. */
function nicknameOf(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'nickname' in body) {
    const value: unknown = body.nickname;
    if (typeof value === 'string') return value;
  }
  return 'Riley';
}

afterEach(cleanup);

async function card(name: string) {
  return (await screen.findByRole('heading', { name })).closest('li')!;
}

describe('[WEBR4-01] an archived child can be activated again, as the confirmation promises', () => {
  it('offers an activation control on an archived card while a paid slot is free', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    const activate = within(riley).getByRole('button', { name: /activate/i });
    await user.click(activate);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ method: 'POST', path: `/v1/children/${RILEY}/activate` });
    // HUNT5-F-11: the confirmation is read out of the PARSED response, so a fixture that drifts from
    // childActivationResponseSchema fails here instead of quietly printing "undefined of 1 in use".
    expect(
      await within(riley).findByText(/uses one of your paid slots \(1 of 1 in use\)/i),
    ).toBeTruthy();
  });

  it('says plainly that no slot is free instead of offering a dead control', async () => {
    const { api } = fakeApi(
      overview(
        [
          { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' },
          { id: SAM, nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', status: 'active' },
        ],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(within(riley).queryByRole('button', { name: /activate/i })).toBeNull();
    expect(riley.textContent).toMatch(/in use/i);
  });

  it('keeps the archived card usable when the activation is refused for a step-up', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
        1,
      ),
      { sendFails: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403) },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /activate/i }));
    expect(await within(riley).findByLabelText('Parent PIN')).toBeTruthy();
    // The control the PIN prompt tells the parent to press again is still there.
    expect(within(riley).getByRole('button', { name: /activate/i })).toBeTruthy();
  });
});

describe('[WEBR4-02] the deletion-pending notice does not promise a cancel that does not exist', () => {
  it('never tells the parent to cancel the deletion request', async () => {
    const { api } = fakeApi(
      overview(
        [
          {
            id: RILEY,
            nickname: 'Riley',
            gradeLevel: 3,
            ageBand: '8-10',
            status: 'archived',
            deletionPending: true,
          },
        ],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(riley.textContent).toMatch(/data deletion under way/i);
    expect(riley.textContent).not.toMatch(/cancel/i);
    // It must still say what the parent can actually do about a mistake.
    expect(riley.textContent).toMatch(/support/i);
  });

  it('offers no activation control for a child under deletion, however many slots are free', async () => {
    const { api } = fakeApi(
      overview(
        [
          {
            id: RILEY,
            nickname: 'Riley',
            gradeLevel: 3,
            ageBand: '8-10',
            status: 'archived',
            deletionPending: true,
          },
        ],
        4,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(within(riley).queryByRole('button', { name: /activate/i })).toBeNull();
  });
});

describe('[WEBR4-03] a child edit sends only the fields the parent changed', () => {
  it('sends the nickname alone, so the other guardian’s grade change survives', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit/i }));
    const nickname = within(riley).getByLabelText(/nickname/i);
    await user.clear(nickname);
    await user.type(nickname, 'Riley R.');
    await user.click(within(riley).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ nickname: 'Riley R.' });
  });

  it('keeps the save button disabled while nothing has been changed', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit/i }));
    const save = within(riley).getByRole('button', { name: /save/i });
    expect(save).toHaveProperty('disabled', true);
    await user.selectOptions(within(riley).getByLabelText(/grade/i), '4');
    expect(within(riley).getByRole('button', { name: /save/i })).toHaveProperty('disabled', false);
    await user.click(within(riley).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ gradeLevel: 4 });
  });
});

describe('[WEBR4-12] the archive control tells the truth and survives a step-up refusal', () => {
  it('does not promise to free a slot for a draft child, which holds none', async () => {
    const { api } = fakeApi(
      overview([{ id: SAM, nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', status: 'draft' }], 1),
    );
    renderPage(<ChildrenPage />, { api });
    const sam = await card('Sam');
    const archive = within(sam).getByRole('button', { name: /archive/i });
    expect(archive.textContent).toMatch(/keeps history/i);
    expect(archive.textContent).not.toMatch(/frees the slot/i);
  });

  it('keeps the confirmation open when the archive is refused for a step-up', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        1,
      ),
      { sendFails: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403) },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /archive/i }));
    await user.click(within(riley).getByRole('button', { name: /yes, archive/i }));
    expect(await within(riley).findByLabelText('Parent PIN')).toBeTruthy();
    // "Press the same button again to continue" must still have a button to press.
    expect(within(riley).getByRole('button', { name: /yes, archive/i })).toBeTruthy();
  });
});

describe('[HUNT5-F-1] the edit form diffs against the props it was SEEDED with', () => {
  it('does not put the stale grade back when a sibling reload moves the row under the open form', async () => {
    const user = userEvent.setup();
    const seeded = overview(
      [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
      2,
    );
    const { api, sends } = fakeApi(seeded, {
      // The other guardian moves Riley up a grade for the new school year.
      later: overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 4, ageBand: '8-10', status: 'active' }],
        2,
      ),
    });
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));
    expect(within(riley).getByLabelText(/nickname/i)).toHaveProperty('value', 'Riley');
    expect(within(riley).getByLabelText(/grade/i)).toHaveProperty('value', '3');

    // A sibling action reloads the family while the edit form stays open and seeded on grade 3.
    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), 'Sam');
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));
    // HUNT6-G-4: this used to wait on `card('Riley').textContent` matching /Grade 4/, which cannot
    // fail — the open EditChildForm renders one <option> per grade, so "Grade 4" is inside the card
    // from the moment the form opened. Proved by hanging the sibling GET: the whole case stayed
    // green while the reload never landed. The card's own detail paragraph is the only node the
    // reload changes, and the grade select cannot produce that exact string.
    await waitFor(async () =>
      expect(within(await card('Riley')).getByText('Grade 4 · ages 8-10')).toBeTruthy(),
    );

    // The parent corrects only the nickname.
    const reloaded = await card('Riley');
    const nickname = within(reloaded).getByLabelText(/nickname/i);
    await user.clear(nickname);
    await user.type(nickname, 'Riley R.');
    await user.click(within(reloaded).getByRole('button', { name: /save Riley/i }));

    await waitFor(() => expect(sends.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    // Grade 3 is the value this form was seeded with, not a change the parent made: sending it would
    // silently put the child back in last year's grade, which is what practice is pitched at.
    expect(sends.find((c) => c.method === 'PATCH')!.body).toEqual({ nickname: 'Riley R.' });
  });
});

describe('[HUNT5-F-3] a successful archive closes the edit form it leaves behind', () => {
  it('leaves no nickname field, no cancel-edit toggle and no save button on the archived card', async () => {
    const user = userEvent.setup();
    const active = overview(
      [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
      1,
    );
    const { api, sends } = fakeApi(active, {
      later: overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
        1,
      ),
    });
    renderPage(<ChildrenPage />, { api });
    let riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));
    expect(within(riley).getByLabelText(/nickname/i)).toBeTruthy();
    await user.click(within(riley).getByRole('button', { name: /archive Riley/i }));
    await user.click(within(riley).getByRole('button', { name: /yes, archive Riley/i }));
    await waitFor(() => expect(sends).toHaveLength(1));

    riley = await card('Riley');
    await waitFor(() => expect(riley.textContent).toMatch(/Archived/));
    // The row that holds "Cancel edit" is hidden for an archived child, so a form left open here
    // cannot be dismissed at all, and its "Save" PATCHes a route the API refuses with CHILD_ARCHIVED.
    expect(within(riley).queryByLabelText(/nickname/i)).toBeNull();
    expect(within(riley).queryByRole('button', { name: /cancel edit/i })).toBeNull();
    expect(within(riley).queryByRole('button', { name: /save Riley/i })).toBeNull();
  });

  it('closes the form when the row turns archived from somewhere else', async () => {
    // The other guardian archives Riley on their own device; the next reload — started by any
    // sibling action on this page — lands that status under the open form. Nothing on this card
    // called archive, so only the render condition can close it.
    const user = userEvent.setup();
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        2,
      ),
      {
        later: overview(
          [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
          2,
        ),
      },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));
    expect(within(riley).getByLabelText(/nickname/i)).toBeTruthy();

    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), 'Sam');
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));

    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/Archived/));
    expect(within(reloaded).queryByLabelText(/nickname/i)).toBeNull();
    expect(within(reloaded).queryByRole('button', { name: /save Riley/i })).toBeNull();
  });
});

describe('[HUNT6-G-5] a status change closes the archive confirmation, not just the edit form', () => {
  it('takes away "Yes, archive" when a reload makes the child deletion-pending', async () => {
    // The other guardian files a child-scope deletion on their own device. `request_deletion`
    // archives the child, so the next reload — started by any sibling action on this page — lands
    // `deletionPending: true` under the confirmation this parent already has open. HUNT5-F-3 gave the
    // edit form that condition; the confirmation in the same card, hidden by the same button row,
    // had none, so the card rendered "nothing can be changed, paired or activated for them" above a
    // live "Yes, archive Riley" that POSTs a route answering NOT_FOUND ('Child not found'), because
    // `visibleChild` excludes a child under an open deletion (apps/api/src/routes/family.ts).
    const user = userEvent.setup();
    const { api, sends } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        2,
      ),
      {
        later: overview(
          [
            {
              id: RILEY,
              nickname: 'Riley',
              gradeLevel: 3,
              ageBand: '8-10',
              status: 'archived',
              deletionPending: true,
            },
          ],
          2,
        ),
      },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /archive Riley/i }));
    expect(within(riley).getByRole('button', { name: /yes, archive Riley/i })).toBeTruthy();

    // A sibling action reloads the family. Nothing on this card was pressed, so only the render
    // condition can close the confirmation.
    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), 'Sam');
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));

    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/data deletion under way/i));
    expect(within(reloaded).queryByRole('button', { name: /yes, archive Riley/i })).toBeNull();
    // And the promise that came with it — "You can activate them again later while a paid slot is
    // free" — is gone too: no archive was sent, and none can be.
    expect(reloaded.textContent).not.toMatch(/activate them again later/i);
    expect(sends.filter((c) => c.path.endsWith('/archive'))).toHaveLength(0);
  });

  it('takes it away when the reload lands an archive from the other guardian', async () => {
    // The idempotent case: the route would answer 200 here, so nothing misleads the parent about the
    // outcome — but the panel still promises a slot is freed for a profile that holds none, and the
    // buttons around it are already hidden for an archived child.
    const user = userEvent.setup();
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        2,
      ),
      {
        later: overview(
          [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
          2,
        ),
      },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /archive Riley/i }));
    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), 'Sam');
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));

    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/Archived/));
    expect(within(reloaded).queryByRole('button', { name: /yes, archive Riley/i })).toBeNull();
  });
});

describe('[HUNT6-G-8] the grade the form is showing can still be saved after a concurrent change', () => {
  it('re-enables Save when the parent puts the grade back, and names what the other guardian changed', async () => {
    // HUNT5-F-1 stopped the silent revert by diffing against the seed, and in doing so made the
    // value the parent can SEE unsavable: the select still reads Grade 3, the card above it reads
    // Grade 4, and no sequence of keystrokes could enable Save for Grade 3 — the diff against the
    // seed is empty for it by construction. Cancel-and-reopen reseeds to Grade 4, the opposite of
    // what a parent correcting the grade wants. The grade is what practice generation is pitched at.
    const user = userEvent.setup();
    const { api, sends } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
        2,
      ),
      {
        later: overview(
          [{ id: RILEY, nickname: 'Riley', gradeLevel: 4, ageBand: '8-10', status: 'active' }],
          2,
        ),
      },
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));

    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), 'Sam');
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));
    const reloaded = await card('Riley');
    await waitFor(async () =>
      expect(within(await card('Riley')).getByText('Grade 4 · ages 8-10')).toBeTruthy(),
    );

    // Nothing edited in this form: Save stays off, because pressing it would put last year's grade
    // back (HUNT5-F-1). What is new is the form saying so, and naming the grade that landed.
    expect(within(reloaded).getByRole('button', { name: /save Riley/i })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      within(reloaded).getByText(/another guardian changed the grade to Grade 4/i),
    ).toBeTruthy();

    // The parent puts the grade back to the one the form is showing them.
    const grade = within(reloaded).getByLabelText(/grade/i);
    expect(grade).toHaveProperty('value', '3');
    await user.selectOptions(grade, '4');
    await user.selectOptions(grade, '3');
    const save = within(reloaded).getByRole('button', { name: /save Riley/i });
    expect(save).toHaveProperty('disabled', false);
    await user.click(save);
    await waitFor(() => expect(sends.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    // Only the field the parent touched travels: the nickname and the age band stay the other
    // guardian's (WEBR4-03, HUNT5-F-1).
    expect(sends.find((c) => c.method === 'PATCH')!.body).toEqual({ gradeLevel: 3 });
  });
});

/**
 * G-PROSE: HUNT6-G-5's own comment claims "One status change now closes every open panel on the card",
 * and two things made that untrue. The pairing-code panel — the card's third open panel — carries no
 * status condition at all, so a code minted while the child was active stays on screen after a reload
 * makes them archived or deletion-pending, where it is dead: the redeem claim in
 * apps/api/src/routes/child-auth.ts matches `c.status = 'active'`, and archiving does not consume the
 * code, so the parent types a code the device will refuse. And `confirmArchive` is only HIDDEN by the
 * new render condition, never cleared — this card is keyed on `child.id`, so a reload never remounts
 * it, and the confirmation reopens itself the moment the child is activated again.
 */
describe('[G-PROSE] one status change closes every open panel, and clears it', () => {
  const rileyAt = (
    status: 'active' | 'archived',
    extra: { deletionPending?: true } = {},
  ): FamilyOverview['children'][number] => ({
    id: RILEY,
    nickname: 'Riley',
    gradeLevel: 3,
    ageBand: '8-10',
    status,
    ...extra,
  });

  /** A fake that answers GET /v1/family with whatever the test has put in `serving` by then. */
  function servingApi(serving: { current: FamilyOverview }): {
    api: Partial<ApiClient>;
    sends: Call[];
  } {
    const sends: Call[] = [];
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_path: string, schema: S) =>
        Promise.resolve(schema.parse(serving.current)),
      send: <S extends z.ZodType>(
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body: unknown,
        schema: S,
      ) => {
        sends.push({ method, path, body });
        const value = path.endsWith('/pairing-code')
          ? { code: 'ABCD-EFGH', expiresAt: '2026-09-24T15:10:00.000Z' }
          : path.endsWith('/activate')
            ? { childId: RILEY, status: 'active', paidSlots: 2, assignedSlots: 1 }
            : { childId: SAM, status: 'draft' };
        return Promise.resolve(schema.parse(value));
      },
    };
    return { api, sends };
  }

  /** A sibling action on the page, which is what reloads GET /v1/family under the open panels. */
  async function addAChild(user: ReturnType<typeof userEvent.setup>, nickname: string) {
    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), nickname);
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));
  }

  it('takes away a pairing code the child can no longer redeem, and says why', async () => {
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api, sends } = servingApi(serving);
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: 'Create pairing code' }));
    expect(await within(riley).findByText('ABCD-EFGH')).toBeTruthy();

    // The other guardian files a child-scope deletion, which archives the child.
    serving.current = overview([rileyAt('archived', { deletionPending: true })], 2);
    await addAChild(user, 'Sam');
    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/data deletion under way/i));

    expect(within(reloaded).queryByText('ABCD-EFGH')).toBeNull();
    expect(within(reloaded).getByText(/can’t connect a device/i)).toBeTruthy();
    expect(sends.filter((c) => c.path.endsWith('/pairing-code'))).toHaveLength(1);
  });

  it('clears the archive confirmation rather than hiding it, so it cannot reopen itself', async () => {
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api, sends } = servingApi(serving);
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: 'Create pairing code' }));
    expect(await within(riley).findByText('ABCD-EFGH')).toBeTruthy();
    await user.click(within(riley).getByRole('button', { name: /archive Riley/i }));
    expect(within(riley).getByRole('button', { name: /yes, archive Riley/i })).toBeTruthy();

    serving.current = overview([rileyAt('archived')], 2);
    await addAChild(user, 'Sam');
    const archived = await card('Riley');
    await waitFor(() => expect(archived.textContent).toMatch(/Archived/));
    expect(within(archived).queryByRole('button', { name: /yes, archive Riley/i })).toBeNull();

    // The parent activates Riley again (WEBR4-01). Nothing was pressed on either panel, so neither
    // may come back: the confirmation's promise was spent, and the code was already dead.
    serving.current = overview([rileyAt('active')], 2);
    await user.click(within(archived).getByRole('button', { name: /Activate Riley again/i }));
    const back = await card('Riley');
    await waitFor(() => expect(back.textContent).toMatch(/Active: uses a paid slot/));
    expect(within(back).queryByRole('button', { name: /yes, archive Riley/i })).toBeNull();
    expect(within(back).queryByText('ABCD-EFGH')).toBeNull();
    expect(sends.filter((c) => c.path.endsWith('/archive'))).toHaveLength(0);
  });
});

/**
 * G-I3-WEB / L-037: the notice asserted the reader's own act. `deletionPending` cannot carry it — GET
 * /v1/family computes the flag from the request's scope and target and never exposes
 * deletion_requests.requested_by (apps/api/src/routes/family.ts) — any guardian may delete a child's
 * data, and a child-scope request leaves every other adult's membership active, so the family's other
 * adult is served the same flag. The app was corrected this round; this is the same sentence here.
 */
describe('[G-I3-WEB] the deletion notice does not tell the reader they asked for it', () => {
  it('names the open request, not the reader', async () => {
    const { api } = fakeApi(
      overview(
        [
          {
            id: RILEY,
            nickname: 'Riley',
            gradeLevel: 3,
            ageBand: '8-10',
            status: 'archived',
            deletionPending: true,
          },
        ],
        2,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(riley.textContent).not.toMatch(/\byou asked\b/i);
    expect(riley.textContent).toMatch(/deletion request covering Riley’s data is open/i);
    // The rest of the notice is unchanged: what is true, and where a mistake is handled.
    expect(within(riley).getByRole('link', { name: /privacy page/i })).toBeTruthy();
    expect(within(riley).getByRole('link', { name: /contact support/i })).toBeTruthy();
  });
});

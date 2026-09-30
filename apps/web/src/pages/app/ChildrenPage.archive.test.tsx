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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));

    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/Archived/));
    expect(within(reloaded).queryByRole('button', { name: /yes, archive Riley/i })).toBeNull();
  });
});

describe('[HUNT6-G-8] the grade the form is showing can still be saved after a concurrent change', () => {
  it('re-enables Save when the parent puts the grade back, and names what changed under the form', async () => {
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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
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
    // HUNT7-G-2: the value that landed, and that it did not land in this form — not an actor the
    // response cannot name.
    expect(
      within(reloaded).getByText(/this profile changed somewhere else while this form was open/i),
    ).toBeTruthy();
    expect(within(reloaded).getByText(/the grade is now Grade 4/i)).toBeTruthy();

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
    // Adding a child needs its own parental attestation (migration 0970), so the sibling action
    // these cases use as a reload lever has to tick the box like a real parent would.
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
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

    // HUNT7-G-5: the notice states the condition this page can speak for — a profile that is not
    // active never redeems a code — and NOT the converse. /pair's claim also requires an unconsumed,
    // unexpired code and then verified consent (apps/api/src/routes/child-auth.ts), and a consent
    // withdrawal consumes every live code for the family while leaving `child_profiles.status` alone
    // (apps/api/src/routes/guardians.ts; the SQL-flip case in
    // apps/api/tests/consent-withdrawal.review.test.ts pairs an ACTIVE child's UNCONSUMED code and
    // gets CONSENT_REQUIRED). This page reads only GET /v1/family, so it cannot see any of that — and
    // must not promise that the next code will connect.
    expect(reloaded.textContent).not.toMatch(/only redeemed for a profile that is active/i);
    expect(reloaded.textContent).toMatch(/never redeemed for a profile that is not active/i);
    expect(reloaded.textContent).toMatch(/checked against your family’s consent too/i);
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

/**
 * HUNT7-G-1: the card's feedback was the first arm of a three-way ternary — `code === null ?
 * <ActionFeedback/> : code === 'stale' ? <stale notice> : <PairingCodePanel/>` — and ActionFeedback is
 * the only renderer of this card's feedback and the only place StepUpNotice -> StepUpPrompt can appear
 * (apps/web/src/pages/app/SecurityPage.tsx, apps/web/src/components/StepUpPrompt.tsx). So whenever the
 * card held a code, every outcome of activate(), archive(), saveProfile() and createCode() was
 * discarded: the success line, an ErrorState for a business rule or a network failure, and the inline
 * PIN field. Round 6 made that window reachable with no press on this card and standing until the
 * parent presses Done, and it exists exactly on the cards whose only offered control is "Activate
 * {nickname} again" — a control whose routine refusal is STEP_UP_REQUIRED, because
 * POST /v1/children/:childId/activate calls assertRecentUnlock (apps/api/src/routes/family.ts) and an
 * unlock lasts a few minutes. WEBR4-01 exists because an archived child with no way back loses their
 * device access, and WEB-R2-05 exists so the PIN is entered on the page the parent is already on.
 *
 * HUNT7-G-7: and the same describe pins the other half of the pairing rule — a code that arrives AFTER
 * the status moved. Synthetic names only.
 */
describe('[HUNT7-G-1] no panel on the card is the reason a refusal is invisible', () => {
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

  /**
   * One card's fake: GET answers whatever `serving.current` holds, `/pairing-code` resolves through
   * `code` (a promise the test can hold open), and `/activate` can refuse the way the server routinely
   * does.
   */
  function cardApi(
    serving: { current: FamilyOverview },
    options: {
      activateFails?: () => ApiRequestError;
      code?: () => Promise<{ code: string; expiresAt: string }>;
    } = {},
  ): { api: Partial<ApiClient>; sends: Call[] } {
    const sends: Call[] = [];
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_path: string, schema: S) =>
        Promise.resolve(schema.parse(serving.current)),
      send: async <S extends z.ZodType>(
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body: unknown,
        schema: S,
      ) => {
        sends.push({ method, path, body });
        if (path.endsWith('/pairing-code')) {
          const value = options.code
            ? await options.code()
            : { code: 'ABCD-EFGH', expiresAt: '2026-09-24T15:10:00.000Z' };
          return schema.parse(value);
        }
        if (path.endsWith('/activate')) {
          if (options.activateFails) throw options.activateFails();
          return schema.parse({ childId: RILEY, status: 'active', paidSlots: 2, assignedSlots: 1 });
        }
        return schema.parse({ childId: SAM, status: 'draft' });
      },
    };
    return { api, sends };
  }

  /** A sibling action on the page, which is what reloads GET /v1/family under the open panels. */
  async function addAChild(user: ReturnType<typeof userEvent.setup>, nickname: string) {
    const add = screen.getByRole('region', { name: 'Add a child' });
    await user.type(within(add).getByLabelText(/nickname/i), nickname);
    await user.click(within(add).getByRole('checkbox', { name: /parent or legal guardian/ }));
    await user.click(within(add).getByRole('button', { name: /add draft child/i }));
  }

  /** An archived card holding the stale pairing-code notice: the state round 6 made standing. */
  async function archivedCardHoldingAStaleCode(
    user: ReturnType<typeof userEvent.setup>,
    serving: { current: FamilyOverview },
  ): Promise<HTMLElement> {
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: 'Create pairing code' }));
    expect(await within(riley).findByText('ABCD-EFGH')).toBeTruthy();
    serving.current = overview([rileyAt('archived')], 2);
    await addAChild(user, 'Sam');
    const archived = await card('Riley');
    await waitFor(() => expect(archived.textContent).toMatch(/can’t connect a device/i));
    return archived;
  }

  it('offers the inline PIN field when the activation under a stale notice is refused', async () => {
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api } = cardApi(serving, {
      activateFails: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<ChildrenPage />, { api });
    const archived = await archivedCardHoldingAStaleCode(user, serving);

    await user.click(within(archived).getByRole('button', { name: /Activate Riley again/i }));
    // The whole point of StepUpPrompt: the PIN is entered here, not behind a link that unmounts this
    // page (WEB-R2-05). Without it the press does nothing at all — no field, no error, no success.
    expect(await within(archived).findByLabelText('Parent PIN')).toBeTruthy();
    // The control the PIN prompt tells the parent to press again is still there, and so is the notice
    // the panel used to replace.
    expect(within(archived).getByRole('button', { name: /Activate Riley again/i })).toBeTruthy();
    expect(archived.textContent).toMatch(/can’t connect a device/i);
  });

  it('shows the success line for an activation that worked under a stale notice', async () => {
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api } = cardApi(serving);
    renderPage(<ChildrenPage />, { api });
    const archived = await archivedCardHoldingAStaleCode(user, serving);

    serving.current = overview([rileyAt('active')], 2);
    await user.click(within(archived).getByRole('button', { name: /Activate Riley again/i }));
    const back = await card('Riley');
    expect(
      await within(back).findByText(/uses one of your paid slots \(1 of 2 in use\)/i),
    ).toBeTruthy();
    // The dead code is still not printed: the feedback became a sibling, it did not replace the rule.
    expect(within(back).queryByText('ABCD-EFGH')).toBeNull();

    // L-057 / two regions on one screen: making the feedback a sibling put the success line on the
    // same card as the stale notice, and the notice still asserted the profile's status itself. The
    // card now reads "Status: Active", "You can now create a pairing code" and a live Create button,
    // so a notice saying Riley's profile is not active — or telling the parent to wait until it is —
    // contradicts three things beside it. `pairingRedeemable` decides the notice too.
    expect(back.textContent).toMatch(/Status: Active/i);
    expect(back.textContent).toMatch(/can’t connect a device any more/i);
    expect(back.textContent).not.toMatch(/and Riley’s is not/i);
    expect(back.textContent).not.toMatch(/(once|if) Riley is active again/i);
    // What holds instead: the code is gone, and the control above it is the way to get another.
    expect(back.textContent).toMatch(/Riley is active again, so you can create a new code/i);
  });

  it('keeps the inline PIN field when Done dismisses the stale notice beside it', async () => {
    // The other newly reachable side effect of making the feedback a sibling: the notice's Done
    // handler cleared `feedback` as well as the code, and `feedback` is the sole input to
    // ActionFeedback -> StepUpNotice -> StepUpPrompt (apps/web/src/pages/app/SecurityPage.tsx). So the
    // press that dismisses a notice about a dead code also threw away the PIN field the parent was
    // typing into — and the PIN is entered here on purpose (WEB-R2-05). `useAction`'s `run` clears the
    // previous feedback itself, so nothing needs this handler to do it.
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api } = cardApi(serving, {
      activateFails: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    renderPage(<ChildrenPage />, { api });
    const archived = await archivedCardHoldingAStaleCode(user, serving);

    await user.click(within(archived).getByRole('button', { name: /Activate Riley again/i }));
    const pin = await within(archived).findByLabelText('Parent PIN');
    await user.type(pin, '135790');
    await user.click(within(archived).getByRole('button', { name: 'Done' }));

    // The notice went; the PIN prompt and what the parent typed into it stayed.
    expect(archived.textContent).not.toMatch(/can’t connect a device any more/i);
    expect(within(archived).getByLabelText('Parent PIN')).toHaveProperty('value', '135790');
  });

  it('a network refusal of the same press is read out, not swallowed', async () => {
    const user = userEvent.setup();
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api } = cardApi(serving, {
      activateFails: () => new ApiRequestError('NETWORK', 'Network request failed', 0),
    });
    renderPage(<ChildrenPage />, { api });
    const archived = await archivedCardHoldingAStaleCode(user, serving);

    await user.click(within(archived).getByRole('button', { name: /Activate Riley again/i }));
    expect(await within(archived).findByText(/Network request failed/i)).toBeTruthy();
  });

  it('never puts a code minted before the status moved on a card that cannot redeem it', async () => {
    // HUNT7-G-7: the effect that turns a held code stale runs once per status change and can only act
    // on the `code` held at that moment, so a POST still in flight resolved AFTERWARDS and put a live
    // code on a card that was simultaneously saying nothing can be paired for this child. The server
    // really does mint it: POST /v1/children/:childId/pairing-code passed its own
    // `child.status !== 'active'` check when the request was made, and archiving does not consume an
    // unexpired code — only the redeem claim's `c.status = 'active'` blocks it.
    const user = userEvent.setup();
    let release: ((value: { code: string; expiresAt: string }) => void) | null = null;
    const pending = new Promise<{ code: string; expiresAt: string }>((resolve) => {
      release = resolve;
    });
    const serving = { current: overview([rileyAt('active')], 2) };
    const { api } = cardApi(serving, { code: () => pending });
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: 'Create pairing code' }));

    // The other guardian files a child-scope deletion, which archives the child; a sibling action on
    // the page is what lands it, because this card's own controls are disabled while it is busy.
    serving.current = overview([rileyAt('archived', { deletionPending: true })], 2);
    await addAChild(user, 'Sam');
    await waitFor(async () =>
      expect((await card('Riley')).textContent).toMatch(/data deletion under way/i),
    );

    release!({ code: 'ABCD-EFGH', expiresAt: '2026-09-24T15:10:00.000Z' });
    const reloaded = await card('Riley');
    await waitFor(() => expect(reloaded.textContent).toMatch(/can’t connect a device/i));
    expect(within(reloaded).queryByText('ABCD-EFGH')).toBeNull();
    // And the parent is told what became of the press, rather than left with a silent card.
    expect(reloaded.textContent).toMatch(/their profile changed before it arrived/i);

    // WEBR4-02 is this project's ledger entry for promising a recovery this card cannot deliver, and
    // this is the card it was filed on: the notice above says processing has stopped, nothing can be
    // activated for them, and deletion can't be undone from the app. So the stale notice may put the
    // next code behind a CONDITION — "if Riley is active again" — and may not presuppose that the
    // condition will be met ("once … again", "not … yet").
    expect(reloaded.textContent).toMatch(/data deletion under way/i);
    expect(reloaded.textContent).not.toMatch(/once Riley is active again/i);
    expect(reloaded.textContent).not.toMatch(/whether that is possible yet/i);
    expect(reloaded.textContent).toMatch(
      /create a new one if Riley is active again — the notices above say whether that is possible/i,
    );
  });
});

/**
 * HUNT7-G-2: the notice said "Another guardian changed …" for ANY difference between the live prop and
 * the seed, and the response cannot establish an actor — `familyChildSchema` is a strict object with no
 * actor field (packages/contracts/src/family.ts) and GET /v1/family selects no actor column
 * (apps/api/src/routes/family.ts), which is why the deletion notice on this same card names the open
 * request instead of the reader (G-I3-WEB). The path below is the reader's OWN save: the PATCH
 * succeeded, its reload failed, `useLastGood` kept the pre-save profile on screen beside "Try again",
 * the parent reopened the form and was seeded from those stale values, and the retry's good GET landed
 * their own new nickname under it. The phone app PATCHing the same child, and a second portal tab, do
 * the same thing. Synthetic names only.
 */
describe('[HUNT7-G-2] the child form’s concurrent-change notice names no actor', () => {
  /** A fake whose PATCH changes the child it SERVES, as the server does, and whose reload can fail. */
  function selfMutatingApi(options: { failReloadOnce?: boolean } = {}): {
    api: Partial<ApiClient>;
    sends: Call[];
  } {
    const sends: Call[] = [];
    let served = overview(
      [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
      2,
    );
    let gets = 0;
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_path: string, schema: S) => {
        gets += 1;
        if (options.failReloadOnce === true && gets === 2) {
          return Promise.reject(new ApiRequestError('NETWORK', 'Network request failed', 0));
        }
        return Promise.resolve(schema.parse(served));
      },
      send: <S extends z.ZodType>(
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body: unknown,
        schema: S,
      ) => {
        sends.push({ method, path, body });
        const nickname = nicknameOf(body);
        served = overview(
          served.children.map((c) => (c.id === RILEY ? { ...c, nickname } : c)),
          2,
        );
        return Promise.resolve(
          schema.parse({
            child: {
              id: RILEY,
              nickname,
              gradeLevel: 3,
              ageBand: '8-10',
              status: 'active',
            },
          }),
        );
      },
    };
    return { api, sends };
  }

  it('does not tell the parent another guardian made the change they made themselves', async () => {
    const user = userEvent.setup();
    const { api, sends } = selfMutatingApi({ failReloadOnce: true });
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));
    const nickname = within(riley).getByLabelText(/nickname/i);
    await user.clear(nickname);
    await user.type(nickname, 'Robin');
    await user.click(within(riley).getByRole('button', { name: /save Riley/i }));
    await waitFor(() => expect(sends).toHaveLength(1));

    // The save WORKED; its reload failed, so the pre-save profile is still on screen with a retry.
    const retry = await screen.findByRole('button', { name: /try again/i });
    await user.click(within(riley).getByRole('button', { name: /edit Riley/i }));
    expect(within(riley).getByLabelText(/nickname/i)).toHaveProperty('value', 'Riley');
    await user.click(retry);

    // The reader's own saved nickname lands under the open form, and the page reads it as drift.
    const renamed = await screen.findByRole('heading', { name: 'Robin' });
    const robin = renamed.closest('li')!;
    // L-054: the sentence the product used to render, over the whole page rather than the notice
    // alone, so moving the claim elsewhere would not pass.
    expect(document.body.textContent).not.toMatch(/another guardian/i);
    const notice = within(robin).getByRole('note');
    expect(notice.textContent).not.toMatch(/guardian|someone else|somebody/i);
    expect(notice.textContent).toMatch(
      /this profile changed somewhere else while this form was open/i,
    );
    expect(notice.textContent).toMatch(/the nickname is now “Robin”/i);
    // HUNT7-G-1: the parent's own confirmation of that very save is on screen beside it, which is what
    // made the actor claim so plainly wrong — and it is only visible because the feedback is a sibling.
    expect(within(robin).getByRole('status').textContent).toMatch(/Saved\. Robin is in/i);
  });
});

/**
 * HUNT7-G-8. `noFreeSlotText` told a family with no paid slot that they have "no paid child slots
 * YET", which asserts they never had one. `releaseSlotlessProfiles`
 * (apps/api/src/services/billing-sync.ts) sets `status = 'draft'` on a previously ACTIVE child
 * whenever verified provider state releases its slot (release_reason 'expired' or 'downgrade'), and
 * `family_capacity.paid_slots` is then 0 for a family that has been paying — so the sentence was
 * false for exactly the lapsed population, once per child, on the page where they manage the children
 * they were paying for. It is the same word and the same premise HUNT6-H-4 removed from the planner
 * (apps/web/src/pages/app/LearningPlannerPage.tsx), in the file that fix named as its model.
 *
 * The remedy is unchanged and stays honest: this portal never sells capacity (WEB-R1-04), so the
 * sentence points at the app to choose or renew a plan and never claims a slot exists. The phone twin
 * `draftActivationNote` (apps/mobile/src/family/family-view.ts) carries the same decision, pinned in
 * apps/mobile/src/family/family-view.test.ts.
 */
describe('[HUNT7-G-8] the no-slot sentence does not tell a lapsed family they never paid', () => {
  it('states it state-neutrally for a draft, with no “yet”', async () => {
    const { api } = fakeApi(
      overview([{ id: SAM, nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', status: 'draft' }], 0),
    );
    renderPage(<ChildrenPage />, { api });
    const sam = await card('Sam');
    expect(sam.textContent).not.toMatch(/no paid child slots yet/i);
    expect(
      within(sam).getByText(
        'Your family has no paid child slots right now. To activate Sam, choose or renew a plan in the PencilLift app.',
      ),
    ).toBeTruthy();
  });

  it('says the same thing on an archived card, which the same helper serves', async () => {
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
        0,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(riley.textContent).not.toMatch(/\byet\b/i);
    expect(riley.textContent).toMatch(/no paid child slots right now/);
    expect(riley.textContent).toMatch(/choose or renew a plan in the PencilLift app/);
  });

  it('leaves the branch where the family demonstrably HAS slots alone', async () => {
    const { api } = fakeApi(
      overview(
        [
          { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
          { id: SAM, nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', status: 'draft' },
        ],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const sam = await card('Sam');
    expect(
      within(sam).getByText(
        'All 1 paid slot is in use. To activate Sam, add a child slot to your plan in the PencilLift app.',
      ),
    ).toBeTruthy();
  });
});

/**
 * HUNT7-G-3 / HUNT7-J-1 (the portal half). HUNT6-G-2 put the `deletionPending` branch in
 * `childStatusLabel` and claimed one helper decides the sentence for every surface; the phone kept
 * printing 'Archived: history only' for a child whose history the purge is deleting until HUNT7-G-3.
 * Nothing on this page asserted the STATUS LINE itself — the WEBR4-02 case above reads the whole
 * card, which the deletion notice satisfies on its own — so the portal's half of the claim was
 * unpinned too, and this is what stops it regressing while the phone is corrected.
 */
describe('[HUNT7-G-3] the portal status line never says the history is kept while it is being deleted', () => {
  it('reads the deletion first, and never “history only”, for an archived deletion-pending child', async () => {
    const { api } = fakeApi(
      overview(
        [
          {
            id: RILEY,
            nickname: 'Riley',
            gradeLevel: 3,
            ageBand: '8-10',
            // `public.request_deletion` archives a child-scope target in the same transaction
            // (migrations 0600, 0890), so this pair is the only reachable shape.
            status: 'archived',
            deletionPending: true,
          },
        ],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(within(riley).getByText('Status: Data deletion under way')).toBeTruthy();
    expect(riley.textContent).not.toMatch(/history only/i);
  });

  it('still says “Archived: history only” for an archive no deletion covers', async () => {
    const { api } = fakeApi(
      overview(
        [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
        1,
      ),
    );
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(within(riley).getByText('Status: Archived: history only')).toBeTruthy();
  });
});

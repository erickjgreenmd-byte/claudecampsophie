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

function fakeApi(
  data: FamilyOverview,
  options: { sendFails?: () => ApiRequestError } = {},
): { api: Partial<ApiClient>; sends: Call[] } {
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(_path: string, schema: S) => Promise.resolve(schema.parse(data)),
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
          : {
              child: {
                id: RILEY,
                nickname: nicknameOf(body),
                gradeLevel: 3,
                ageBand: '8-10',
                status: 'active',
              },
            };
      const parsed = schema.safeParse(value);
      return parsed.success ? Promise.resolve(parsed.data) : Promise.resolve(value as z.infer<S>);
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

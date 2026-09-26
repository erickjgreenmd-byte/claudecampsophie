import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { FamilyOverview } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import ChildrenPage from './ChildrenPage.tsx';

/**
 * WEB-R2-03: no client could change a child's grade, nickname or age band, and nothing called the
 * archive route, so a family stayed on last year's grade after the school year rolled over and
 * could only free a paid slot by deleting the child's whole history. Synthetic names only.
 */

const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';

function family(): FamilyOverview {
  return {
    id: FAMILY,
    displayName: 'Test Family',
    timezone: 'America/Chicago',
    paidSlots: 1,
    billingConflict: null,
    managingChannel: 'app_store',
    children: [
      { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
      { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
    ],
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi() {
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(_path: string, schema: S) => Promise.resolve(schema.parse(family())),
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      const value = path.endsWith('/archive')
        ? { childId: RILEY, status: 'archived', paidSlots: 1, assignedSlots: 0, note: 'unchanged' }
        : {
            child: {
              id: RILEY,
              nickname: 'Riley',
              gradeLevel: 4,
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

afterEach(cleanup);

async function card(name: string) {
  return (await screen.findByRole('heading', { name })).closest('li')!;
}

describe('[WEB-R2-03] a child profile can be corrected from the portal', () => {
  it('sends the new grade, nickname and age band as PATCH /v1/children/:id', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');

    const edit = within(riley).getByRole('button', { name: /edit .*Riley|edit profile/i });
    await user.click(edit);
    const grade = within(riley).getByLabelText(/grade/i);
    await user.selectOptions(grade, '4');
    const nickname = within(riley).getByLabelText(/nickname/i);
    await user.clear(nickname);
    await user.type(nickname, 'Riley R.');
    await user.click(within(riley).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    // WEBR4-03: this used to expect `ageBand: '8-10'` as well, although the age band was never
    // touched here. That assertion was wrong: sending an untouched field overwrites whatever the
    // other guardian saved into it in the meantime, which is exactly what the form's own doc comment
    // promises not to do. The body now carries only the two fields this test changes.
    expect(sends[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/children/${RILEY}`,
      body: { nickname: 'Riley R.', gradeLevel: 4 },
    });
    expect(sends[0]!.body).not.toHaveProperty('ageBand');
  });

  it('offers every age band the contract allows, from the schema', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit/i }));
    const bands = within(riley).getByLabelText(/age band/i);
    for (const band of ['5-7', '8-10', '11-13']) {
      expect(within(bands).getByRole('option', { name: `Ages ${band}` })).toBeTruthy();
    }
  });

  it('refuses an empty nickname in the browser without sending anything', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    await user.click(within(riley).getByRole('button', { name: /edit/i }));
    await user.clear(within(riley).getByLabelText(/nickname/i));
    await user.click(within(riley).getByRole('button', { name: /save/i }));
    expect(await within(riley).findByRole('alert')).toBeTruthy();
    expect(sends).toHaveLength(0);
  });
});

describe('[WEB-R2-03] a child can be archived from the portal', () => {
  it('confirms first, then calls the archive route that had no caller', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');

    const archive = within(riley).getByRole('button', { name: /archive/i });
    // The copy must say what archiving does: history is kept and the paid slot is freed.
    expect(archive.textContent).toMatch(/keeps history/i);
    await user.click(archive);
    // Nothing is sent before the parent confirms.
    expect(sends).toHaveLength(0);
    await user.click(within(riley).getByRole('button', { name: /yes, archive/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ method: 'POST', path: `/v1/children/${RILEY}/archive` });
  });

  it('never offers archiving for a profile that is already archived', async () => {
    const archivedFamily: FamilyOverview = {
      ...family(),
      children: [
        { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' },
      ],
    };
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_p: string, schema: S) =>
        Promise.resolve(schema.parse(archivedFamily)),
    };
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(within(riley).queryByRole('button', { name: /archive/i })).toBeNull();
    expect(within(riley).queryByRole('button', { name: /edit/i })).toBeNull();
  });
});

describe('[ACC-FAM-03] a child whose data deletion is under way is listed, labelled and read-only', () => {
  /**
   * GET /v1/family keeps such a child (the privacy screens resolve its nickname out of that list for
   * the pending-deletion list, its exports and its safety reports) and flags it with
   * `deletionPending`. The server refuses activation, pairing and edits for it, so this page must
   * offer no control on it and say why.
   *
   * HUNT5-F-9: this used to give a second reason, that the request could still be called off. It
   * cannot — see ChildrenPage.tsx's deletion-pending notice (WEBR4-02): /v1/privacy exposes only
   * POST and GET /deletion, nothing moves deletion_requests.status to 'cancelled', and BUG-221
   * removed that claim from the parent copy, which now says deletion can't be undone from the app.
   */
  const pending: FamilyOverview = {
    ...family(),
    children: [
      {
        id: RILEY,
        nickname: 'Riley',
        gradeLevel: 3,
        ageBand: '8-10',
        status: 'archived',
        deletionPending: true,
      },
      { id: SAM, nickname: 'Sam', gradeLevel: 0, ageBand: '5-7', status: 'draft' },
    ],
  };

  it('still shows the child by name, says the deletion is under way and offers no control', async () => {
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_p: string, schema: S) => Promise.resolve(schema.parse(pending)),
    };
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(riley.textContent).toMatch(/data deletion under way/i);
    for (const name of [/archive/i, /edit/i, /pairing code/i, /paid slot/i]) {
      expect(within(riley).queryByRole('button', { name })).toBeNull();
    }
    // The other child is untouched: the flag is per child, not per family.
    const sam = await card('Sam');
    expect(within(sam).queryByRole('button', { name: /edit/i })).not.toBeNull();
  });

  it('offers no control even when the profile is still active (the request/activation race)', async () => {
    // The flag, not the status, is what must silence the card: a request filed while an activation
    // was in flight leaves an `active` profile under an open deletion, and the API answers NOT_FOUND
    // for pairing, activation and edits on it, so a button here would only be a dead end.
    const racing: FamilyOverview = {
      ...family(),
      children: [
        {
          id: RILEY,
          nickname: 'Riley',
          gradeLevel: 3,
          ageBand: '8-10',
          status: 'active',
          deletionPending: true,
        },
      ],
    };
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_p: string, schema: S) => Promise.resolve(schema.parse(racing)),
    };
    renderPage(<ChildrenPage />, { api });
    const riley = await card('Riley');
    expect(riley.textContent).toMatch(/data deletion under way/i);
    for (const name of [/archive/i, /edit/i, /pairing code/i]) {
      expect(within(riley).queryByRole('button', { name })).toBeNull();
    }
  });
});

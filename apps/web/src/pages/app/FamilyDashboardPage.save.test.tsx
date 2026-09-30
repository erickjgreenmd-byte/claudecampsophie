import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ConsentStatus, FamilyOverview } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import FamilyDashboardPage from './FamilyDashboardPage.tsx';

/**
 * Round-4 hardening of the WEB-R2-03 family-details form. Synthetic names only.
 *
 *  - WEBR4-04 the success message lived inside the collapsible form, which onSaved() unmounted, so a
 *    save that worked showed no confirmation at all; when the reload that followed failed,
 *    useLastGood kept the OLD name and zone on screen next to an error banner, so the parent
 *    concluded the save had failed and retried while the server had already changed the zone every
 *    release, review and report is planned in.
 *  - WEBR4-03 the form always sent displayName + timezone, so correcting only the name reverted the
 *    other guardian's time-zone change.
 */

const FAMILY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

const family: FamilyOverview = {
  id: FAMILY,
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: 'app_store',
  children: [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
};

const consent: ConsentStatus = {
  state: 'verified',
  consentId: null,
  isTestProvider: true,
  configuredProviderIsTest: true,
  verifiedAt: '2026-09-01T12:00:00.000Z',
  withdrawnAt: null,
  policyVersion: '2026-09-v1',
  currentPolicyVersion: '2026-09-v1',
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * `familyReloadFails`: the GET after a successful PATCH rejects, as an offline blip would.
 * `familyByGet`: what each GET /v1/family answers, by call number (the last entry repeats), so a
 * later read can land the other guardian's change under a form the parent has open (HUNT5-F-1).
 */
function fakeApi(
  options: {
    familyReloadFails?: boolean;
    familyByGet?: readonly (FamilyOverview | ApiRequestError)[];
  } = {},
) {
  const sends: Call[] = [];
  let familyGets = 0;
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path.startsWith('/v1/consent')) return Promise.resolve(schema.parse(consent));
      familyGets += 1;
      if (options.familyByGet) {
        const answer =
          options.familyByGet[Math.min(familyGets - 1, options.familyByGet.length - 1)]!;
        return answer instanceof ApiRequestError
          ? Promise.reject(answer)
          : Promise.resolve(schema.parse(answer));
      }
      if (options.familyReloadFails && familyGets > 1) {
        return Promise.reject(new ApiRequestError('NETWORK', 'Network request failed', 0));
      }
      return Promise.resolve(schema.parse(family));
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      sends.push({ method, path, body });
      const value = {
        family: { id: FAMILY, displayName: 'The Riveras', timezone: 'America/Chicago' },
      };
      return Promise.resolve(schema.parse(value));
    },
  };
  return { api, sends };
}

afterEach(cleanup);

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Test Family' });
  await user.click(screen.getByRole('button', { name: /edit family name and time zone/i }));
}

describe('[WEBR4-04] a saved family change is confirmed where the parent can see it', () => {
  it('shows the success message after the form closes, even when the reload fails', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi({ familyReloadFails: true });
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/saved/i);
    expect(status.textContent).toMatch(/The Riveras/);
  });
});

describe('[WEBR4-03] a family edit sends only the fields the parent changed', () => {
  it('sends the name alone, so the other guardian’s time-zone change survives', async () => {
    const user = userEvent.setup();
    const { api, sends } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));

    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.body).toEqual({ displayName: 'The Riveras' });
  });

  it('keeps the save button disabled while nothing has been changed', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi();
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    expect(screen.getByRole('button', { name: /^save family details$/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('[HUNT5-F-1] the family form diffs against the props it was SEEDED with', () => {
  it('does not put the stale time zone back when a retry lands the other guardian’s change', async () => {
    // The path: a save whose reload failed leaves the ErrorState's "Try again" beside the form
    // (WEBR4-04 keeps the last good family on screen). The parent reopens the form, presses Try
    // again, and that read lands guardian B's new zone under the open form.
    const user = userEvent.setup();
    const moved: FamilyOverview = { ...family, timezone: 'Europe/Berlin' };
    const { api, sends } = fakeApi({
      familyByGet: [family, new ApiRequestError('NETWORK', 'Network request failed', 0), moved],
    });
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));
    await waitFor(() => expect(sends).toHaveLength(1));
    // The reload failed: the old family is still on screen, with a retry.
    const retry = await screen.findByRole('button', { name: /try again/i });

    await openForm(user);
    expect(screen.getByLabelText(/time zone/i)).toHaveProperty('value', 'America/Chicago');
    await user.click(retry);
    // The read lands: the summary above the open form now reads the new zone. The form's own field
    // still shows what it was seeded with, which is the point — it is not a change the parent made.
    //
    // HUNT6-G-3: this used to synchronise on `getAllByText(/Europe\/Berlin/)`, which cannot fail: the
    // form's own IANA hint renders <code>Europe/Berlin</code> (FamilyDashboardPage.tsx's zone hint),
    // so the wait was satisfied by the open form itself and resolved before the retry's GET had
    // resolved — proved by hanging that GET, which left the whole case green. The summary paragraph
    // above the form is the ONLY node the reload changes, so it is the one to wait on.
    expect(await screen.findByText('Time zone: Europe/Berlin')).toBeTruthy();
    expect(screen.getByLabelText(/time zone/i)).toHaveProperty('value', 'America/Chicago');

    const name2 = screen.getByLabelText(/family name/i);
    await user.clear(name2);
    await user.type(name2, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));
    await waitFor(() => expect(sends).toHaveLength(2));
    // Sending America/Chicago here would revert the zone every release, review and report is
    // planned in — the loss WEBR4-03 was filed for.
    expect(sends[1]!.body).toEqual({ displayName: 'The Riveras' });
  });
});

describe('[HUNT5-F-2] the dashboard row of a child under deletion does not claim its history is kept', () => {
  it('says the deletion is under way instead of "Archived: history only"', async () => {
    const { api } = fakeApi({
      familyByGet: [
        {
          ...family,
          children: [
            {
              id: RILEY,
              nickname: 'Riley',
              gradeLevel: 3,
              ageBand: '8-10',
              status: 'archived',
              deletionPending: true,
            },
          ],
        },
      ],
    });
    renderPage(<FamilyDashboardPage />, { api });
    const row = await screen.findByText(/Riley/);
    expect(row.closest('li')!.textContent).toMatch(/data deletion under way/i);
    expect(row.closest('li')!.textContent).not.toMatch(/history only/i);
  });
});

describe('[HUNT6-G-8] the zone the form is showing can still be saved after a concurrent change', () => {
  it('re-enables Save when the parent edits the field back, and names what changed under the form', async () => {
    // The state HUNT5-F-1 left behind: the summary above the form reads Europe/Berlin, the field
    // reads the America/Chicago this form was opened with, and `nothingChanged` diffed the field
    // against that seed — so the value the parent can SEE, and wants, could not be saved by any
    // keystroke: clearing and retyping it left the diff empty and Save greyed out, with nothing on
    // screen explaining why. Cancel-and-reopen reseeds to Europe/Berlin, which is the opposite of
    // what the parent is trying to do.
    const user = userEvent.setup();
    const moved: FamilyOverview = { ...family, timezone: 'Europe/Berlin' };
    const { api, sends } = fakeApi({
      familyByGet: [family, new ApiRequestError('NETWORK', 'Network request failed', 0), moved],
    });
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));
    await waitFor(() => expect(sends).toHaveLength(1));
    const retry = await screen.findByRole('button', { name: /try again/i });

    await openForm(user);
    await user.click(retry);
    expect(await screen.findByText('Time zone: Europe/Berlin')).toBeTruthy();

    // Nothing has been edited in this form, so Save stays off: pressing it would revert the other
    // guardian's zone, which is the loss HUNT5-F-1 was filed for. What is new is that the form SAYS
    // what happened, and names the value that landed.
    expect(screen.getByRole('button', { name: /^save family details$/i })).toHaveProperty(
      'disabled',
      true,
    );
    // HUNT7-G-2: what LANDED, not who landed it. GET /v1/family carries no actor (the schema is
    // strict and the route selects no such column), so the notice names the value and the fact that
    // it came from somewhere other than this form.
    expect(
      screen.getByText(/this family changed somewhere else while this form was open/i),
    ).toBeTruthy();
    expect(screen.getByText(/the time zone is now Europe\/Berlin/i)).toBeTruthy();

    // The parent edits the zone field back to the value it is showing them. That is an explicit
    // statement about that field, so Save works and sends that field alone.
    const zone = screen.getByLabelText(/time zone/i);
    expect(zone).toHaveProperty('value', 'America/Chicago');
    await user.clear(zone);
    await user.type(zone, 'America/Chicago');
    const save = screen.getByRole('button', { name: /^save family details$/i });
    expect(save).toHaveProperty('disabled', false);
    await user.click(save);
    await waitFor(() => expect(sends).toHaveLength(2));
    // The name was not edited in this reopened form, so it is not sent: only the field the parent
    // touched travels (WEBR4-03, HUNT5-F-1).
    expect(sends[1]!.body).toEqual({ timezone: 'America/Chicago' });
  });
});

/**
 * HUNT7-G-2: the notice said "Another guardian changed …" for ANY difference between the live prop and
 * the seed, and the response cannot establish an actor: `familyOverviewResponseSchema` is a strict
 * object with no actor field (packages/contracts/src/family.ts) and GET /v1/family selects no actor
 * column (apps/api/src/routes/family.ts) — the same fact that made the portal's deletion notices name
 * the open request instead of the reader (G-I3-WEB). Two writers that are not another guardian reach
 * it: the reader on a second surface (the phone app PATCHes the same family, and a second tab does
 * too), and — the path below — the reader's own save whose RELOAD failed, where `useLastGood` keeps the
 * pre-save values, the reopened form is seeded from them, and the retry's good GET lands the parent's
 * own new name under it. For a one-guardian family the sentence also asserted that a second adult can
 * write to the family. Synthetic names only.
 */
describe('[HUNT7-G-2] the concurrent-change notice names no actor the response cannot name', () => {
  /**
   * A fake whose PATCH changes the family it SERVES, as the server does. `fakeApi` above leaves the
   * served overview untouched by a save, which is why no existing case can see the reader's own
   * change come back as drift.
   */
  function selfMutatingApi(options: { failReloadOnce?: boolean } = {}) {
    const sends: Call[] = [];
    let served: FamilyOverview = family;
    let gets = 0;
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(path: string, schema: S) => {
        if (path.startsWith('/v1/consent')) return Promise.resolve(schema.parse(consent));
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
        const patch = (body ?? {}) as Partial<Pick<FamilyOverview, 'displayName' | 'timezone'>>;
        served = {
          ...served,
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
        };
        return Promise.resolve(
          schema.parse({
            family: { id: FAMILY, displayName: served.displayName, timezone: served.timezone },
          }),
        );
      },
    };
    return { api, sends };
  }

  it('does not tell the parent another guardian made the change they made themselves', async () => {
    const user = userEvent.setup();
    const { api, sends } = selfMutatingApi({ failReloadOnce: true });
    renderPage(<FamilyDashboardPage />, { api });
    await openForm(user);
    const name = screen.getByLabelText(/family name/i);
    await user.clear(name);
    await user.type(name, 'The Riveras');
    await user.click(screen.getByRole('button', { name: /^save family details$/i }));
    await waitFor(() => expect(sends).toHaveLength(1));
    // The save WORKED and its reload failed: the pre-save name is still on screen beside a retry
    // (WEBR4-04), and reopening the form seeds it from those stale values.
    const retry = await screen.findByRole('button', { name: /try again/i });
    await openForm(user);
    expect(screen.getByLabelText(/family name/i)).toHaveProperty('value', 'Test Family');
    await user.click(retry);
    // The reader's own saved name lands under the open form, which the page reads as drift.
    expect(await screen.findByRole('heading', { name: 'The Riveras' })).toBeTruthy();

    // L-054: the sentence the product used to render, over the WHOLE page rather than the notice
    // alone, so moving the claim elsewhere does not pass.
    expect(document.body.textContent).not.toMatch(/another guardian/i);
    // And no attribution to any adult inside the notice itself.
    const notice = screen.getByRole('note');
    expect(notice.textContent).not.toMatch(/guardian|someone else|somebody/i);
    // What the data supports: the value, and that it did not come from this form.
    expect(notice.textContent).toMatch(
      /this family changed somewhere else while this form was open/i,
    );
    expect(notice.textContent).toMatch(/the family name is now “The Riveras”/i);
  });
});

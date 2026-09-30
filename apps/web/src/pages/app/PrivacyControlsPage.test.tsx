import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  DataExports,
  DeletionRequests,
  PrivacyFamilyView,
  SafetyReports,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  ACCOUNT_CLOSE_COPY,
  ACCOUNT_CLOSE_OUTCOME_COPY,
  PARENT_SAFETY_FLAG_ACTIONS,
  PARENT_SAFETY_FLAG_COPY,
  SIGN_OUT_NOT_TOLD_COPY,
  type SafetyReport,
} from '@pencillift/contracts';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import type { AuthAdapter, SessionRead } from '../../lib/auth.ts';
import { RequireParent, SessionProvider } from '../../lib/session.tsx';
import { renderPage } from '../../test/render.tsx';
import AccountDeletionPage from '../public/AccountDeletionPage.tsx';
import PrivacyControlsPage from './PrivacyControlsPage.tsx';

/** Stands in for the public deletion page, echoing the router state the portal hands it. */
function DeletionPageStub() {
  const state = useLocation().state as { accountClosed?: string; signOutRefused?: boolean } | null;
  return (
    <>
      <p>{`deletion page: ${state?.accountClosed ?? 'no state'}`}</p>
      {/* HUNT5-F-8: the closure flow must hand this page the sign-out report, so the parent on a
          shared computer is told when the auth service was never told to end the session. */}
      <p>{`sign-out report: ${state?.signOutRefused === true ? 'server not told' : 'carried out'}`}</p>
    </>
  );
}

/**
 * Renders the privacy page with a route for the public deletion page (account closure lands there).
 *
 * HUNT7-I-5: the portal route is real, and gated the way every portal page is gated — its own
 * `RequireParent` (PrivacyControlsPage.tsx:52, HomeworkPage.tsx:64, RewardsPage.tsx:42). With
 * `initialEntries` the caller can put a portal entry BEHIND /app/privacy, which is what a browser
 * history holds, so a Back can be asked what it actually renders instead of being clamped by a
 * one-entry history.
 */
function renderWithDeletionRoute(
  api: Partial<ApiClient>,
  auth: AuthAdapter,
  initialEntries: readonly string[] = ['/app/privacy'],
) {
  const router = createMemoryRouter(
    [
      {
        path: '/app',
        element: (
          <RequireParent>
            <h1>Your family</h1>
            <p>Riley</p>
          </RequireParent>
        ),
      },
      { path: '/app/privacy', element: <PrivacyControlsPage /> },
      { path: '/account-deletion', element: <DeletionPageStub /> },
    ],
    { initialEntries: [...initialEntries] },
  );
  const client: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: () => Promise.reject(new Error('unexpected send')),
    ...api,
  };
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api: client,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/**
 * The same flow, landing on the REAL public deletion page rather than the stub, so what a parent
 * actually reads after an account closure is asserted rather than the router state alone
 * (HUNT5-F-8's other half: the flag was handed over and nothing rendered it).
 */
function renderWithRealDeletionPage(api: Partial<ApiClient>, auth: AuthAdapter) {
  const router = createMemoryRouter(
    [
      { path: '/app/privacy', element: <PrivacyControlsPage /> },
      { path: '/account-deletion', element: <AccountDeletionPage /> },
    ],
    { initialEntries: ['/app/privacy'] },
  );
  const client: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: () => Promise.reject(new Error('unexpected send')),
    ...api,
  };
  render(
    <SessionProvider
      value={{
        config: { apiBaseUrl: '/api', supabaseUrl: null, supabasePublishableKey: null },
        auth,
        api: client,
      }}
    >
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/**
 * A refused sign-out, in the shape the real adapter reports one: it RESOLVES with
 * `{ serverNotTold: true }` (never throws — lib/auth.ts's SignOutReport). `cleared` says whether this
 * browser's session is really gone afterwards, which is the only thing that can license "This computer
 * is signed out": the report itself is returned straight after a best-effort storage removal that
 * cannot say what it achieved, so it carries nothing about this origin's session (HUNT6-F-3).
 *
 * HUNT6-F-REFUTED: this used to explain `cleared: false` as the real adapter's behaviour, "supabase-js
 * returned its error before removeCurrentSession(), so its in-memory session — the one
 * `currentSession()` answers from — can survive". @supabase/auth-js 2.116.0 has no in-memory session:
 * `getSession()` goes through `_useSession` -> `__loadSession`, which re-reads `this.storage` on every
 * call, so removing the stored key removes what it reads. Neither of its refusal paths leaves a
 * readable session either — it removes the session itself before returning a /logout failure, and a
 * refusal from the pre-flight refresh leaves the stored token but `getSession()` hits the same refresh
 * failure and answers `session: null`. Both are run against the real library in App.signout.test.tsx's
 * [HUNT6-F-PREMISE] and [HUNT6-F-REFUTED] cases.
 *
 * So `cleared: false` is not production's library. It is the case the re-read exists for, and the rule
 * it pins is the page's, not auth-js's: a refusal over a session this browser can still read must
 * never be presented as a finished sign-out. It is reachable by an adapter that throws, a
 * `currentSession()` that throws, a storage adapter other than the two auth-js picks for itself,
 * another tab writing a session back, and the next auth-js.
 *
 * HUNT7-F-1: `unreadable` is the third answer, and the one this flow got wrong. `currentSession()`
 * answers `null` both when there is no session and when the session could not be read — which is what
 * the Supabase adapter's `getSession()` resolves while a refresh keeps failing over a session the
 * removal did not reach. Only `readSession()` separates them, and "could not be read" may never be
 * spent as "this computer is signed out".
 */
function reportedRefusal(options: { readonly cleared: boolean; readonly unreadable?: boolean }): {
  auth: AuthAdapter;
  attempts: () => number;
} {
  let attempted = 0;
  let gone = false;
  const session = { accessToken: 'test-token', email: 'parent@example.test' };
  return {
    attempts: () => attempted,
    auth: {
      configured: true,
      currentSession: () => Promise.resolve(gone ? null : session),
      readSession: () =>
        Promise.resolve<SessionRead>(
          gone
            ? options.unreadable
              ? { state: 'unreadable' }
              : { state: 'signed_out' }
            : { state: 'signed_in', session },
        ),
      signOut: () => {
        attempted += 1;
        if (options.cleared) gone = true;
        return Promise.resolve({ serverNotTold: true as const });
      },
    },
  };
}

function signOutCounter(): { auth: AuthAdapter; count: () => number } {
  let signedOut = 0;
  return {
    count: () => signedOut,
    auth: {
      configured: true,
      currentSession: () =>
        Promise.resolve({ accessToken: 'test-token', email: 'parent@example.test' }),
      signOut: () => {
        signedOut += 1;
        return Promise.resolve();
      },
    },
  };
}

// Synthetic data only (Riley, Sam).
const FAMILY_ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const EXPORT_ID = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const DELETION_ID = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';
const REPORT_A = 'c07c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d0e';
const REPORT_B = 'd18d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e1f';

const FAMILY: PrivacyFamilyView = {
  id: FAMILY_ID,
  children: [
    { id: RILEY, nickname: 'Riley', status: 'active' },
    { id: SAM, nickname: 'Sam', status: 'active' },
  ],
};

const NO_DELETIONS: DeletionRequests = { requests: [] };
const NO_EXPORTS: DataExports = { exports: [] };
const NO_REPORTS: SafetyReports = { reports: [] };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fixed response, or a function producing one per call. */
type Responder = unknown;

function fakeApi(
  options: {
    family?: Responder;
    deletion?: Responder;
    exports?: Responder;
    reports?: Responder;
    send?: (call: Call) => unknown;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const settle = <S extends z.ZodType>(value: unknown, schema: S) => {
    try {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const value = (r: Responder, fallback: unknown) =>
    r === undefined ? fallback : typeof r === 'function' ? (r as () => unknown)() : r;
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      if (path === '/v1/family') return settle(value(options.family, FAMILY), schema);
      if (path === '/v1/deletion') return settle(value(options.deletion, NO_DELETIONS), schema);
      if (path === '/v1/exports') return settle(value(options.exports, NO_EXPORTS), schema);
      if (path === '/v1/safety-reports') return settle(value(options.reports, NO_REPORTS), schema);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      if (!options.send) return Promise.reject(new Error(`unexpected ${method} ${path}`));
      return settle(options.send(call), schema);
    },
  };
  return { api, gets, sends };
}

const stepUp = () =>
  new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue', 403);

function queuedExport(kind: string, childId: string | null = null) {
  return {
    export: {
      id: EXPORT_ID,
      kind,
      childId,
      status: 'queued',
      createdAt: '2026-09-24T15:00:00.000Z',
      expiresAt: null,
    },
  };
}

function deletion(scope: 'family' | 'child', childId: string | null = null) {
  return {
    id: DELETION_ID,
    scope,
    childId,
    status: 'requested',
    requestedAt: '2026-09-24T15:00:00.000Z',
    completeBy: '2026-10-24T15:00:00.000Z',
    completedAt: null,
  };
}

/** A family report with the contract's full shape (strict schema); nothing acted on or sent. */
function report(overrides: Partial<SafetyReport> & Pick<SafetyReport, 'id'>): SafetyReport {
  return {
    reporterKind: 'child',
    category: 'other',
    childId: RILEY,
    questionId: null,
    note: null,
    status: 'open',
    createdAt: '2026-09-23T15:00:00.000Z',
    triagedAt: null,
    resolvedAt: null,
    clearedAsFalseMatch: false,
    parentActionAt: null,
    parentOutcome: null,
    emailedAt: null,
    emailStatus: 'not_sent',
    ...overrides,
  };
}

/** A safety-screen flag about Riley, escalated and unresolved unless overridden. */
function flag(overrides: Partial<SafetyReport> = {}): SafetyReport {
  return report({
    id: REPORT_A,
    reporterKind: 'system',
    category: 'severe_risk',
    questionId: 'e29e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a',
    status: 'escalated',
    ...overrides,
  });
}

afterEach(cleanup);

const text = (el: Element | null | undefined): string => el?.textContent ?? '';

describe('PrivacyControlsPage', () => {
  it('explains retention, deletion timing, backups, billing records and store subscriptions', async () => {
    const { api } = fakeApi();
    renderPage(<PrivacyControlsPage />, { api });
    await screen.findByRole('heading', { level: 1, name: /privacy, export and deletion/i });
    const retention = await screen.findByRole('region', { name: /how long we keep information/i });
    const text = retention.textContent ?? '';
    expect(text).toMatch(/raw homework photos are deleted after 30 days by default/i);
    expect(text).toMatch(/within 30 days/i);
    expect(text).toMatch(/backups expire on a documented schedule/i);
    expect(text).toMatch(/billing records/i);
    // WEB-R1-04: the retention notice names every store that can bill a family, including the
    // Amazon Appstore (the old page-wide pattern matched only "an App Store or Google Play
    // subscription"), and says to cancel in the store that bills you.
    expect(text).toMatch(
      /does not cancel an App Store, Google Play or Amazon Appstore subscription/i,
    );
    expect(text).toMatch(
      /Cancel it in the store that bills you \(App Store, Google Play or Amazon Appstore\)/,
    );
  });

  it('shows loading first, then honest empty states', async () => {
    const { api } = fakeApi();
    renderPage(<PrivacyControlsPage />, { api });
    expect(text(await screen.findByRole('status'))).toMatch(/loading/i);
    expect(await screen.findByText(/no exports requested yet/i)).toBeTruthy();
    expect(screen.getByText(/no safety reports yet/i)).toBeTruthy();
    expect(screen.getByText(/no deletion requests/i)).toBeTruthy();
  });

  it('requests a family data export and shows its real status', async () => {
    let exports: DataExports = NO_EXPORTS;
    const { api, sends } = fakeApi({
      exports: () => exports,
      send: () => {
        const created = queuedExport('family_data');
        exports = { exports: [created.export] } as DataExports;
        return created;
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /export your data/i });
    await userEvent.selectOptions(within(section).getByLabelText(/what to export/i), 'family_data');
    await userEvent.click(within(section).getByRole('button', { name: /request export/i }));
    expect(sends).toEqual([{ method: 'POST', path: '/v1/exports', body: { kind: 'family_data' } }]);
    expect(await within(section).findByText(/export requested/i)).toBeTruthy();
    const list = await within(section).findByRole('list', { name: /your exports/i });
    expect(text(list)).toMatch(/all family data/i);
    expect(text(list)).toMatch(/waiting to be prepared/i);
    // Honest: no download control exists while nothing can be downloaded.
    expect(within(section).queryByRole('button', { name: /download/i })).toBeNull();
    expect(within(section).queryByRole('link', { name: /download/i })).toBeNull();
  });

  it('a review questions export needs a child; the answer key uses its own protected route', async () => {
    const { api, sends } = fakeApi({
      send: (call) =>
        call.path === '/v1/exports/answer-key'
          ? queuedExport('review_answer_key_pdf', RILEY)
          : queuedExport('review_questions_pdf', SAM),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /export your data/i });
    await userEvent.selectOptions(
      within(section).getByLabelText(/what to export/i),
      'review_questions_pdf',
    );
    await userEvent.click(within(section).getByRole('button', { name: /request export/i }));
    expect(await within(section).findByText(/choose a child for a review export/i)).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.selectOptions(within(section).getByLabelText(/^child$/i), SAM);
    await userEvent.click(within(section).getByRole('button', { name: /request export/i }));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: '/v1/exports',
      body: { kind: 'review_questions_pdf', childId: SAM },
    });

    const key = within(section).getByRole('group', { name: /answer key/i });
    await userEvent.selectOptions(within(key).getByLabelText(/child for the answer key/i), RILEY);
    await userEvent.click(within(key).getByRole('button', { name: /request answer key/i }));
    expect(sends[1]).toEqual({
      method: 'POST',
      path: '/v1/exports/answer-key',
      body: { childId: RILEY },
    });
    // The general export form never offers the answer key.
    expect(
      within(within(section).getByLabelText(/what to export/i)).queryByRole('option', {
        name: /answer key/i,
      }),
    ).toBeNull();
  });

  it('asks for the parent PIN when the server requires a step-up, then lets the parent retry', async () => {
    let unlocked = false;
    const { api, sends } = fakeApi({
      send: (call) => {
        if (call.path === '/v1/adult/unlock') {
          unlocked = true;
          return { unlockedUntil: '2026-09-24T15:05:00.000Z', unlockSeconds: 300 };
        }
        return unlocked ? queuedExport('progress_pdf') : stepUp();
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /export your data/i });
    await userEvent.selectOptions(
      within(section).getByLabelText(/what to export/i),
      'progress_pdf',
    );
    await userEvent.click(within(section).getByRole('button', { name: /request export/i }));
    const prompt = await within(section).findByRole('group', { name: /enter your parent pin/i });
    await userEvent.type(within(prompt).getByLabelText(/parent pin/i), '482913');
    await userEvent.click(within(prompt).getByRole('button', { name: /unlock/i }));
    expect(sends[1]).toEqual({
      method: 'POST',
      path: '/v1/adult/unlock',
      body: { method: 'pin', pin: '482913' },
    });
    expect(await within(section).findByText(/unlocked/i)).toBeTruthy();
    // Nothing sensitive is retried automatically; the parent presses the action again.
    expect(sends).toHaveLength(2);
    await userEvent.click(within(section).getByRole('button', { name: /request export/i }));
    expect(sends[2]).toEqual({
      method: 'POST',
      path: '/v1/exports',
      body: { kind: 'progress_pdf' },
    });
    expect(await within(section).findByText(/export requested/i)).toBeTruthy();
  });

  it('deleting a child needs the child’s name typed exactly before anything is sent', async () => {
    let deletions: DeletionRequests = NO_DELETIONS;
    const { api, sends } = fakeApi({
      deletion: () => deletions,
      send: () => {
        const created = deletion('child', SAM);
        deletions = { requests: [created] } as DeletionRequests;
        return { deletion: created };
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const card = await screen.findByRole('group', { name: /delete a child’s data/i });
    await userEvent.selectOptions(within(card).getByLabelText(/child to delete/i), SAM);
    await userEvent.type(within(card).getByLabelText(/type sam to confirm/i), 'Riley');
    await userEvent.click(within(card).getByRole('button', { name: /delete sam’s data/i }));
    expect(await within(card).findByText(/type sam exactly/i)).toBeTruthy();
    expect(sends).toHaveLength(0);

    const confirm = within(card).getByLabelText(/type sam to confirm/i);
    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'Sam');
    await userEvent.click(within(card).getByRole('button', { name: /delete sam’s data/i }));
    expect(sends).toEqual([
      { method: 'POST', path: '/v1/deletion', body: { scope: 'child', childId: SAM } },
    ]);
    expect(text(await within(card).findByText(/deletion requested/i))).toMatch(/oct/i);
    const list = await screen.findByRole('list', { name: /deletion requests/i });
    expect(text(list)).toMatch(/sam/i);
    expect(text(list)).toMatch(/processing has stopped/i);
  });

  it('family deletion needs DELETE typed and explains owner-only and step-up refusals', async () => {
    const { api, sends } = fakeApi({
      send: (call) =>
        call.path === '/v1/deletion'
          ? new ApiRequestError(
              'FORBIDDEN',
              'Only the family owner can delete the whole family',
              403,
              'OWNER_ONLY_FAMILY_DELETION',
            )
          : new Error('unexpected'),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const card = await screen.findByRole('group', { name: /delete your whole family account/i });
    await userEvent.type(within(card).getByLabelText(/type delete to confirm/i), 'delete');
    await userEvent.click(within(card).getByRole('button', { name: /delete our family account/i }));
    expect(await within(card).findByText(/type delete in capital letters/i)).toBeTruthy();
    expect(sends).toHaveLength(0);

    const confirm = within(card).getByLabelText(/type delete to confirm/i);
    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'DELETE');
    await userEvent.click(within(card).getByRole('button', { name: /delete our family account/i }));
    expect(sends).toEqual([{ method: 'POST', path: '/v1/deletion', body: { scope: 'family' } }]);
    expect(text(await within(card).findByRole('alert'))).toMatch(/only the family owner/i);
  });

  it('shows the step-up prompt when family deletion needs a fresh PIN', async () => {
    const { api } = fakeApi({ send: () => stepUp() });
    renderPage(<PrivacyControlsPage />, { api });
    const card = await screen.findByRole('group', { name: /delete your whole family account/i });
    await userEvent.type(within(card).getByLabelText(/type delete to confirm/i), 'DELETE');
    await userEvent.click(within(card).getByRole('button', { name: /delete our family account/i }));
    expect(await within(card).findByRole('group', { name: /enter your parent pin/i })).toBeTruthy();
    expect(
      within(card)
        .getByRole('link', { name: /security page/i })
        .getAttribute('href'),
    ).toBe('/app/security');
  });

  it('switches to the deleted-account state right after a successful family deletion', async () => {
    let deleted = false;
    const { api } = fakeApi({
      family: () =>
        deleted ? new ApiRequestError('NOT_FOUND', 'Create your family first', 404) : FAMILY,
      exports: () =>
        deleted ? new ApiRequestError('NOT_FOUND', 'Create your family first', 404) : NO_EXPORTS,
      reports: () =>
        deleted ? new ApiRequestError('NOT_FOUND', 'Create your family first', 404) : NO_REPORTS,
      deletion: () => (deleted ? { requests: [deletion('family')] } : NO_DELETIONS),
      send: () => {
        deleted = true;
        return { deletion: deletion('family') };
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const card = await screen.findByRole('group', { name: /delete your whole family account/i });
    await userEvent.type(within(card).getByLabelText(/type delete to confirm/i), 'DELETE');
    await userEvent.click(within(card).getByRole('button', { name: /delete our family account/i }));
    expect(
      await screen.findByRole('heading', { name: /your family account is being deleted/i }),
    ).toBeTruthy();
    // The stale family controls are gone, not kept on screen from the last good load; only the
    // parent's own account closure remains (APL-07 / PLAY-10).
    expect(screen.queryByRole('region', { name: /export your data/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /delete our family account|delete data/i }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /delete my account/i })).toBeTruthy();
  });

  it('shows a deleted-account state after the family was deleted', async () => {
    const { api } = fakeApi({
      family: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      exports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      reports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      deletion: { requests: [deletion('family')] },
    });
    renderPage(<PrivacyControlsPage />, { api });
    expect(
      await screen.findByRole('heading', { name: /your family account is being deleted/i }),
    ).toBeTruthy();
    expect(screen.getByText(/oct/i)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /delete our family account|delete data/i }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: /delete my account/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /request export/i })).toBeNull();
    // WEB-R1-04: the notice names every store that can bill a family, including the Amazon
    // Appstore (the old pattern matched only "an App Store or Google Play subscription").
    expect(
      screen.getAllByText(
        /does not cancel an App Store, Google Play or Amazon Appstore subscription/i,
      ),
    ).not.toHaveLength(0);
  });

  it('lists family safety reports with who reported them and their status', async () => {
    const reports: SafetyReports = {
      reports: [
        report({
          id: REPORT_A,
          reporterKind: 'child',
          category: 'answer_revealed',
          childId: RILEY,
          status: 'open',
          createdAt: '2026-09-23T15:00:00.000Z',
        }),
        report({
          id: REPORT_B,
          reporterKind: 'parent',
          category: 'wrong_or_confusing',
          childId: SAM,
          note: 'The hint did not match the worksheet.',
          status: 'resolved',
          createdAt: '2026-09-22T15:00:00.000Z',
          triagedAt: '2026-09-22T16:00:00.000Z',
          resolvedAt: '2026-09-22T17:00:00.000Z',
        }),
      ],
    };
    const { api } = fakeApi({ reports });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(text(items[0])).toMatch(/showed an answer/i);
    expect(text(items[0])).toMatch(/reported by riley/i);
    expect(text(items[0])).toMatch(/waiting for review/i);
    // A child's report: no email is sent for it, and it says so; only "looked into" is offered.
    expect(text(items[0])).toContain(PARENT_SAFETY_FLAG_COPY.emailNotSent);
    expect(
      within(items[0]!).getByRole('button', { name: PARENT_SAFETY_FLAG_ACTIONS.addressed.label }),
    ).toBeTruthy();
    expect(within(items[0]!).queryByRole('button', { name: /false alarm/i })).toBeNull();
    // A parent's own report is reviewed by PencilLift: nothing to act on.
    expect(text(items[1])).toMatch(/reported by a parent/i);
    expect(text(items[1])).toMatch(/resolved/i);
    expect(text(items[1])).toMatch(/did not match the worksheet/i);
    expect(within(items[1]!).queryAllByRole('button')).toEqual([]);
  });

  it('shows a safety-screen flag honestly, with resources and the recorded email state (AC_SECURITY_02)', async () => {
    const reports: SafetyReports = { reports: [flag({ emailStatus: 'not_sent' })] };
    const { api } = fakeApi({ reports });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    const [item] = within(list).getAllByRole('listitem');
    const content = text(item);
    expect(content).toMatch(/answer flagged for a grown-up/i);
    expect(content).toMatch(/flagged by pencillift/i);
    expect(content).toMatch(/riley/i);
    expect(content).toMatch(/escalated for urgent review/i);
    expect(content).toMatch(/pencillift flagged an answer for a grown-up to look at/i);
    // The recorded delivery: no email was sent, and the row never claims one.
    expect(content).toContain(PARENT_SAFETY_FLAG_COPY.emailNotSent);
    expect(content).not.toContain(PARENT_SAFETY_FLAG_COPY.emailSent);
    // It says what the product shows, not what the child saw (opening results is not recorded).
    expect(content).not.toMatch(/your child saw/i);
    expect(content).toMatch(/988/);
    expect(content).toMatch(/1-800-422-4453/);
    expect(content).toMatch(/911/);
    // Never claims a delivery that did not happen, and never names the kind of concern the word
    // match suggested.
    expect(content.replace(/no email has been sent/i, '')).not.toMatch(
      /alerted|notified|we (?:emailed|texted|sent)|pencillift emailed/i,
    );
    // (The resources line names the hotlines; that is not about this report.)
    expect(content.replace(PARENT_SAFETY_FLAG_COPY.resources, '')).not.toMatch(
      /self-harm|suicid|abuse|sexual|violen/i,
    );
  });

  it('says an email was sent only when the delivery is recorded, and says when it failed', async () => {
    const { api } = fakeApi({
      reports: {
        reports: [
          flag({ id: REPORT_A, emailStatus: 'sent', emailedAt: '2026-09-23T15:00:05.000Z' }),
          flag({
            id: REPORT_B,
            emailStatus: 'failed',
            createdAt: '2026-09-22T15:00:00.000Z',
          }),
        ],
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    const [sent, failed] = within(list).getAllByRole('listitem');
    expect(text(sent)).toContain(PARENT_SAFETY_FLAG_COPY.emailSent);
    expect(text(sent)).toMatch(/names no child, no question and no kind of concern/i);
    expect(text(failed)).toContain(PARENT_SAFETY_FLAG_COPY.emailFailed);
    expect(text(failed)).toMatch(/could not be sent/i);
    expect(text(failed)).not.toContain(PARENT_SAFETY_FLAG_COPY.emailSent);
  });

  it('offers the two actions on an unresolved flag and explains what each does', async () => {
    const { api } = fakeApi({ reports: { reports: [flag()] } });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    const [item] = within(list).getAllByRole('listitem');
    const buttons = within(item!)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual([
      PARENT_SAFETY_FLAG_ACTIONS.addressed.label,
      PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label,
    ]);
    const content = text(item);
    expect(content).toContain(PARENT_SAFETY_FLAG_ACTIONS.addressed.effect);
    expect(content).toContain(PARENT_SAFETY_FLAG_ACTIONS.falseMatch.effect);
    // The false-alarm action says what happens to the child's results and the question.
    expect(content).toMatch(/removes the message from your child’s results/i);
    expect(content).toMatch(/check the question like the rest of the scan/i);
    expect(content).toMatch(/both need a recent parent pin unlock/i);
  });

  it('"I’ve looked into this" sends the outcome, then reloads the list', async () => {
    let acted = false;
    const { api, sends, gets } = fakeApi({
      reports: () => ({
        reports: [
          acted
            ? flag({
                status: 'resolved',
                resolvedAt: '2026-09-24T15:00:00.000Z',
                parentActionAt: '2026-09-24T15:00:00.000Z',
                parentOutcome: 'addressed',
              })
            : flag(),
        ],
      }),
      send: (call) => {
        if (call.path === `/v1/safety-reports/${REPORT_A}`) {
          acted = true;
          return {
            report: flag({
              status: 'resolved',
              resolvedAt: '2026-09-24T15:00:00.000Z',
              parentActionAt: '2026-09-24T15:00:00.000Z',
              parentOutcome: 'addressed',
            }),
          };
        }
        return new Error(`unexpected ${call.path}`);
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    await userEvent.click(
      within(list).getByRole('button', { name: PARENT_SAFETY_FLAG_ACTIONS.addressed.label }),
    );
    expect(sends).toEqual([
      { method: 'PATCH', path: `/v1/safety-reports/${REPORT_A}`, body: { outcome: 'addressed' } },
    ]);
    await waitFor(() => {
      expect(gets.filter((g) => g === '/v1/safety-reports').length).toBeGreaterThan(1);
    });
    // The resolved row shows the outcome and offers nothing more.
    const item = await within(
      await screen.findByRole('list', { name: /family safety reports/i }),
    ).findByText(PARENT_SAFETY_FLAG_COPY.addressed);
    const row = item.closest('li')!;
    expect(text(row)).toMatch(/resolved/i);
    expect(text(row)).not.toContain(PARENT_SAFETY_FLAG_COPY.summary);
    expect(within(row).queryAllByRole('button')).toEqual([]);
  });

  it('"This was a false alarm" sends false_match and says the question is checked normally', async () => {
    const { api, sends } = fakeApi({
      reports: { reports: [flag()] },
      send: () => ({
        report: flag({
          status: 'resolved',
          resolvedAt: '2026-09-24T15:00:00.000Z',
          clearedAsFalseMatch: true,
          parentActionAt: '2026-09-24T15:00:00.000Z',
          parentOutcome: 'false_match',
        }),
      }),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    await userEvent.click(
      within(list).getByRole('button', { name: PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label }),
    );
    expect(sends).toEqual([
      { method: 'PATCH', path: `/v1/safety-reports/${REPORT_A}`, body: { outcome: 'false_match' } },
    ]);
    expect(await screen.findByText(/cleared as a false alarm/i)).toBeTruthy();
  });

  it('asks for the parent PIN when acting on a flag needs a step-up; nothing is retried by itself', async () => {
    const { api, sends } = fakeApi({
      reports: { reports: [flag()] },
      send: (call) =>
        call.path === '/v1/adult/unlock'
          ? { unlockedUntil: '2026-09-24T15:05:00.000Z', unlockSeconds: 300 }
          : stepUp(),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    await userEvent.click(
      within(list).getByRole('button', { name: PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label }),
    );
    const prompt = await within(list).findByRole('group', { name: /enter your parent pin/i });
    await userEvent.type(within(prompt).getByLabelText(/parent pin/i), '482913');
    await userEvent.click(within(prompt).getByRole('button', { name: /unlock/i }));
    expect(await within(list).findByText(/unlocked/i)).toBeTruthy();
    expect(text(list)).toContain(`Press “${PARENT_SAFETY_FLAG_ACTIONS.falseMatch.label}” again`);
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ method: 'PATCH', body: { outcome: 'false_match' } });
    expect(sends[1]).toMatchObject({ path: '/v1/adult/unlock' });
  });

  it('a report resolved meanwhile explains the refusal (409) instead of failing silently', async () => {
    const { api } = fakeApi({
      reports: { reports: [flag()] },
      send: () => new ApiRequestError('CONFLICT', 'This report is already resolved', 409),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    await userEvent.click(
      within(list).getByRole('button', { name: PARENT_SAFETY_FLAG_ACTIONS.addressed.label }),
    );
    expect(await within(list).findByText(/already resolved/i)).toBeTruthy();
  });

  it('a flag cleared as a false match says so, not that the child sees a message (round 3)', async () => {
    const reports: SafetyReports = {
      reports: [
        flag({
          questionId: 'e29e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2b',
          status: 'resolved',
          triagedAt: '2026-09-23T16:00:00.000Z',
          resolvedAt: '2026-09-23T16:00:00.000Z',
          clearedAsFalseMatch: true,
        }),
      ],
    };
    const { api } = fakeApi({ reports });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /family safety reports/i });
    const [item] = within(list).getAllByRole('listitem');
    const content = text(item);
    expect(content).toContain(PARENT_SAFETY_FLAG_COPY.cleared);
    expect(content).not.toContain(PARENT_SAFETY_FLAG_COPY.summary);
    expect(content).toMatch(/not a concern/i);
    expect(content).toMatch(/resolved/i);
    expect(within(item!).queryAllByRole('button')).toEqual([]);
    expect(content.replace(PARENT_SAFETY_FLAG_COPY.resources, '')).not.toMatch(
      /alerted|notified|we (?:emailed|texted|sent)|self-harm|suicid|abuse|sexual|violen/i,
    );
  });

  it('parents cannot choose the system-only category when sending a report', async () => {
    const { api } = fakeApi();
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /safety reports/i });
    const select = within(section).getByLabelText(/what happened/i);
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(options).not.toContain('Answer flagged for a grown-up');
    expect(options).toHaveLength(6); // "Choose one" + the five parent categories
    expect(text(section)).toMatch(
      /pencillift also adds a report here[^.]*flags one of your child’s answers/i,
    );
    // Owner decision (2026-09-25): no flag is held from this list, every flag is emailed to a
    // verified guardian address (each row says whether that email was sent), and the parent
    // addresses it. The page no longer speaks of held flags, and still does not promise a staffed
    // review of every flag (triage targets and the reviewer are not approved yet, Owner action #24).
    //
    // WEBR4-07: the previous assertion here pinned "emails the guardians on this account", the exact
    // overclaim CS-R2-06 removed from PARENT_SAFETY_FLAG_COPY.emailSent and that
    // apps/api/tests/jobs-r2.review.test.ts:467 asserts the contract copy must NOT make. The job
    // emails only VERIFIED addresses (jobs/dispatcher.ts) and records `sent` as soon as one accepts,
    // so an unverified co-guardian, or one whose address bounced, read on this page that they had
    // been emailed. The assertion was wrong, not the product; the intro must not claim it either.
    expect(text(section)).not.toMatch(/emails the guardians on this account/i);
    expect(text(section)).toMatch(/verified/i);
    expect(text(section)).toMatch(/says whether that email was sent/i);
    expect(text(section)).not.toMatch(/kept off this list|reviewer releases/i);
    expect(text(section)).not.toMatch(/sends no automatic alert/i);
    expect(text(section)).not.toMatch(
      /looks at every flag|reviews every flag|every flag is reviewed/i,
    );
  });

  it('never loads the safety screen’s rules into the parent bundle (copy comes from contracts)', () => {
    const sources = import.meta.glob<string>('./PrivacyControlsPage.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const source = Object.values(sources)[0]!;
    expect(source).toContain('PARENT_SAFETY_FLAG_COPY');
    expect(source).not.toContain('@pencillift/domain/safety');
  });

  it('says which child choices save a report and that “Tell a grown-up” sends nothing', async () => {
    // Spec P4: "Never promise that the parent is alerted unless delivery is implemented and
    // logged" (RV-privacy-7). Only the child's "Tell PencilLift" choices create a report.
    const { api } = fakeApi();
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /safety reports/i });
    const intro = text(section.querySelector('p'));
    expect(intro).toMatch(/“tell pencillift” choices[^.]*saved to pencillift’s review queue/i);
    expect(intro).toMatch(/“tell a grown-up”[^.]*doesn’t send anything or alert anyone/i);
  });

  it('shows an expired export as expired, with no download control', async () => {
    const { api } = fakeApi({
      exports: {
        exports: [
          {
            ...queuedExport('family_data').export,
            status: 'expired',
            expiresAt: '2026-09-24T15:00:00.000Z',
          },
        ],
      },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const list = await screen.findByRole('list', { name: /your exports/i });
    expect(text(list)).toMatch(/expired — request a new copy/i);
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });

  it('shows another guardian the deleted-account state without saying they asked for it', async () => {
    // RV-privacy-5: GET /v1/deletion now includes the owner's family deletion for a guardian.
    const notFound = () => new ApiRequestError('NOT_FOUND', 'Create your family first', 404);
    const { api } = fakeApi({
      family: notFound,
      exports: notFound,
      reports: notFound,
      deletion: { requests: [deletion('family')] },
    });
    renderPage(<PrivacyControlsPage />, { api });
    const heading = await screen.findByRole('heading', {
      name: /your family account is being deleted/i,
    });
    const card = heading.closest('section');
    expect(text(card)).toMatch(/processing stopped when the deletion was requested/i);
    expect(text(card)).not.toMatch(/when you asked/i);
    expect(screen.queryByRole('link', { name: /set up your family/i })).toBeNull();
  });

  it('lets a parent report a concern', async () => {
    const { api, sends } = fakeApi({
      send: () => ({
        report: report({
          id: REPORT_A,
          reporterKind: 'parent',
          category: 'unsafe_content',
          childId: null,
          note: 'Tone felt wrong.',
          createdAt: '2026-09-24T15:00:00.000Z',
        }),
      }),
    });
    renderPage(<PrivacyControlsPage />, { api });
    const section = await screen.findByRole('region', { name: /safety reports/i });
    await userEvent.selectOptions(
      within(section).getByLabelText(/what happened/i),
      'unsafe_content',
    );
    await userEvent.type(within(section).getByLabelText(/note/i), 'Tone felt wrong.');
    await userEvent.click(within(section).getByRole('button', { name: /send report/i }));
    expect(sends).toEqual([
      {
        method: 'POST',
        path: '/v1/safety-reports',
        body: { category: 'unsafe_content', note: 'Tone felt wrong.' },
      },
    ]);
    expect(await within(section).findByText(/report saved/i)).toBeTruthy();
  });

  it('shows an offline message with a working retry when loading fails', async () => {
    let fail = true;
    const { api, gets } = fakeApi({
      family: () =>
        fail ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0) : FAMILY,
    });
    renderPage(<PrivacyControlsPage />, { api });
    expect(text(await screen.findByRole('alert'))).toMatch(/offline/i);
    fail = false;
    const before = gets.length;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByRole('region', { name: /export your data/i });
    expect(gets.length).toBeGreaterThan(before);
  });

  it('[APL-20] no longer says exports are switched off; a ready export offers a one-minute download link', async () => {
    const ready = {
      id: EXPORT_ID,
      kind: 'progress_csv',
      childId: null,
      status: 'ready',
      createdAt: '2026-09-24T15:00:00.000Z',
      expiresAt: '2026-10-01T15:00:00.000Z',
    };
    const { api, gets } = fakeApi({ exports: { exports: [ready] } });
    const client = api as Partial<ApiClient> & { get: ApiClient['get'] };
    const baseGet = client.get;
    client.get = <S extends z.ZodType>(path: string, schema: S) => {
      if (path === `/v1/exports/${EXPORT_ID}/download`) {
        gets.push(path);
        return Promise.resolve(
          schema.parse({
            url: 'https://storage.example.test/signed/progress.csv?token=abc',
            // WEB-R2-07: the signed link now disappears once it has expired, so this fixture's
            // expiry has to be a live one-minute window rather than a fixed past instant (the fixed
            // instant was already in the past whenever the suite ran, which is the L-027 trap).
            // The assertion below is unchanged: a ready export offers a one-minute download link.
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      }
      return baseGet(path, schema);
    };
    renderPage(<PrivacyControlsPage />, { api });
    const exportsRegion = await screen.findByRole('region', { name: /export your data/i });
    expect(exportsRegion.textContent).not.toMatch(
      /switched on|aren.t prepared|isn.t available yet/i,
    );
    expect(exportsRegion.textContent).toMatch(/ready to download/i);
    await userEvent.click(
      within(exportsRegion).getByRole('button', { name: /get download link/i }),
    );
    const link = await within(exportsRegion).findByRole('link', { name: /download file/i });
    expect(link.getAttribute('href')).toBe(
      'https://storage.example.test/signed/progress.csv?token=abc',
    );
    expect(gets).toContain(`/v1/exports/${EXPORT_ID}/download`);
  });

  it('a download that needs a fresh PIN shows the step-up prompt instead of a link', async () => {
    const ready = {
      id: EXPORT_ID,
      kind: 'family_data',
      childId: null,
      status: 'ready',
      createdAt: '2026-09-24T15:00:00.000Z',
      expiresAt: '2026-10-01T15:00:00.000Z',
    };
    const { api } = fakeApi({ exports: { exports: [ready] } });
    const client = api as Partial<ApiClient> & { get: ApiClient['get'] };
    const baseGet = client.get;
    client.get = (path, schema) =>
      path.endsWith('/download') ? Promise.reject(stepUp()) : baseGet(path, schema);
    renderPage(<PrivacyControlsPage />, { api });
    const exportsRegion = await screen.findByRole('region', { name: /export your data/i });
    await userEvent.click(
      within(exportsRegion).getByRole('button', { name: /get download link/i }),
    );
    expect(
      await within(exportsRegion).findByRole('group', { name: /enter your parent pin/i }),
    ).toBeTruthy();
    expect(within(exportsRegion).queryByRole('link', { name: /download file/i })).toBeNull();
  });

  it('[APL-07 / PLAY-10] "Delete my account" needs the box ticked, then sends the confirmation, signs the device out and lands on the public page', async () => {
    const { auth, count } = signOutCounter();
    const { api, sends } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    expect(card.textContent).toMatch(/closes your PencilLift sign-in/i);
    expect(card.textContent).toMatch(/delete your whole family account first/i);
    expect(card.textContent).toMatch(
      /does not cancel an App Store, Google Play or Amazon Appstore subscription/i,
    );
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await within(card).findByText(/tick the box/i)).toBeTruthy();
    expect(sends).toHaveLength(0);
    expect(count()).toBe(0);

    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: closed')).toBeTruthy();
    expect(count()).toBe(1);
    expect(sends).toEqual([{ method: 'POST', path: '/v1/account/close', body: { confirm: true } }]);
  });

  /**
   * Lead follow-up to WEB-R4-AUTH-2 (round 4): a refused sign-out must not swallow the navigation.
   * This handler awaited it bare, so the parent was left on a page that needs a signed-in parent —
   * with their account already closed on the server. The close is done by then, so the page moves on
   * either way.
   *
   * HUNT5-F-8: the shape of a refusal is the one ACC-WEB-AUTH-A settled — the adapter RETURNS
   * `{ serverNotTold: true }`, it does not throw (supabase-auth.ts, and auth.ts's SignOutReport),
   * precisely so this flow can carry on. The earlier test supplied a rejecting adapter, a shape the
   * contract forbids, so it exercised a path the real adapter never takes and the report was thrown
   * away on a screen that then tells the parent the device is signed out. Both shapes are covered
   * here, and the report travels with the navigation the way SignOutControl reports it.
   *
   * These two cases pin the handover (the stub echoes the router state); what the parent READS at the
   * other end is pinned against the real page in the [HUNT5-F-8] / [HUNT6-G-6] cases at the end of
   * this file.
   *
   * HUNT6-G-1 inverted the first of them. It supplied a `currentSession` that keeps answering and
   * asserted that the flow travels to a page whose first sentence is "This computer is signed out". It
   * pinned the defect in. A reported refusal is now told apart from a cleared one by the same re-read
   * SignOutControl does on every path, and this case is the half where the session survived.
   *
   * HUNT6-F-REFUTED: the reason given for that `currentSession` was "the real adapter's behaviour after
   * a refusal, because supabase-js returns its error before removeCurrentSession() and only the stored
   * localStorage key is removed". It is not the real adapter's behaviour and there is no such
   * in-memory session — auth-js 2.116.0 re-reads storage on every `getSession()`, and both of its
   * refusal paths leave nothing readable (App.signout.test.tsx, [HUNT6-F-PREMISE] and
   * [HUNT6-F-REFUTED]). What this half pins is the decision rule, which does not depend on which
   * library is underneath: a reported refusal over a session this browser can still read licenses
   * nothing. See `reportedRefusal` above for what reaches it.
   */
  it('[HUNT6-G-1] keeps the parent here, and claims nothing, when the reported refusal left the session readable', async () => {
    const { auth, attempts } = reportedRefusal({ cleared: false });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    const router = renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(text(await within(card).findByRole('alert'))).toMatch(
      /you are still signed in on this computer/i,
    );
    // The closure is still reported, because it really happened.
    expect(card.textContent).toMatch(/your request is recorded/i);
    expect(attempts()).toBe(1);
    // Nothing travelled, so nothing anywhere says this computer is signed out.
    expect(router.state.location.pathname).toBe('/app/privacy');
    expect(screen.queryByText(/deletion page:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/this computer is signed out/i);
    // And the success outcome is gone: every one of its lines ends "this device is signed out".
    for (const line of Object.values(ACCOUNT_CLOSE_OUTCOME_COPY)) {
      expect(document.body.textContent).not.toContain(line.full);
    }
  });

  it('[HUNT6-G-1] carries the refusal report to the public page when the reported refusal did clear this browser', async () => {
    const { auth, attempts } = reportedRefusal({ cleared: true });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: pending')).toBeTruthy();
    expect(await screen.findByText('sign-out report: server not told')).toBeTruthy();
    expect(attempts()).toBe(1);
  });

  /**
   * HUNT7-F-1: a session the adapter could not READ is not a session that is gone, and this is the
   * screen where spending one as the other is worst. The public page's refusal notice opens "This
   * computer is signed out"; a refusal whose storage removal did not get through leaves the session
   * where auth-js keeps it, and `getSession()` — hitting the same refresh failure that caused the
   * refusal — answers `session: null` with an error. The parent closes their account on a shared
   * computer, reads that it is signed out, and walks away from a session the network brings back.
   * A read that could not tell keeps them here, where the portal's own Sign out is.
   */
  it('[HUNT7-F-1] keeps the parent here when the session could not be read, not only when it answered', async () => {
    const { auth, attempts } = reportedRefusal({ cleared: true, unreadable: true });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    const router = renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(text(await within(card).findByRole('alert'))).toMatch(
      /you are still signed in on this computer/i,
    );
    expect(card.textContent).toMatch(/your request is recorded/i);
    expect(attempts()).toBe(1);
    expect(router.state.location.pathname).toBe('/app/privacy');
    expect(screen.queryByText(/deletion page:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/this computer is signed out/i);
  });

  /**
   * HUNT6-G-1: the navigation REPLACES the portal entry, so the closed account's own page is not one
   * Back away.
   *
   * HUNT7-I-5: what makes a Back safe is not the missing entry. This branch is reached only when the
   * session is gone from this browser (`signOutRefused === false`, which the adapter returns only
   * after auth-js removed the session, or a reported refusal whose re-read found nothing), and every
   * portal page renders behind its own `RequireParent`, which re-reads THIS browser's session on
   * every mount (lib/session.tsx:72-93, :117-130) — a Back remounts, so the read runs again. The
   * comment used to justify the replace by "one Back used to put the next person back inside the
   * parent portal", conflating the server-side sign-in that `pending` keeps alive with the stored
   * session RequireParent actually reads; and this case measured history DEPTH in a router built with
   * a single entry, where `navigate(-1)` is clamped, so it could not have seen the difference. The
   * history now holds a portal entry behind the closure, as a real browser's does, and the assertion
   * is the property: going back renders no portal content.
   */
  it('[HUNT6-G-1 / HUNT7-I-5] a Back after the closure reaches no portal content', async () => {
    const { auth } = reportedRefusal({ cleared: true });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    const router = renderWithDeletionRoute(api, auth, ['/app', '/app/privacy']);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: pending')).toBeTruthy();
    // The privacy entry was replaced, so one Back lands on the portal page behind it — and that page
    // shows the sign-in prompt, because the session this browser held is gone.
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/app'));
    // The gate re-reads the session on this mount, so the prompt is what settles (never the family).
    await waitFor(() => expect(document.body.textContent).toMatch(/please sign in/i));
    expect(screen.queryByRole('heading', { name: 'Your family' })).toBeNull();
    expect(screen.queryByText('Riley')).toBeNull();
    expect(screen.queryByRole('region', { name: /delete my account/i })).toBeNull();
  });

  /**
   * HUNT5-N6: a sign-out that THREW is off the adapter's contract, so nothing about it is known —
   * least of all that this browser's stored session was removed. Reporting it as `signOutRefused`
   * made the public page say "This computer is signed out", a sentence nothing had checked, exactly
   * the claim SignOutControl refuses to make: it re-reads `currentSession()` first and, when the
   * session survived, stays put and says so. The close flow now does the same. Two cases, told apart
   * by that re-read and nothing else.
   *
   * This case replaces one that asserted the opposite ("a sign-out that threw did not end the session
   * either, so it is reported the same way"): that sentence is about the SERVER's session, and the
   * page's sentence is about THIS COMPUTER's, so it licensed a claim the flow had not verified.
   */
  it('[HUNT5-N6] does not say this computer is signed out when a thrown sign-out left the session in place', async () => {
    let attempted = 0;
    const auth: AuthAdapter = {
      configured: true,
      // Unchanged by the sign-out: the stored session is still here afterwards.
      currentSession: () =>
        Promise.resolve({ accessToken: 'test-token', email: 'parent@example.test' }),
      signOut: () => {
        attempted += 1;
        return Promise.reject(new Error('auth server refused the sign-out'));
      },
    };
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    // The parent is told the session survived, in SignOutControl's words for the same fact, and the
    // closure is restated in the same sentence by `stillSignedInCopy` (PrivacyControlsPage.tsx) —
    // HUNT6-G-7: NOT by the action outcome, which the flow drops at `action.setOutcome(null)` two
    // lines earlier precisely because both of its lines end "and this device is signed out". That is
    // what the assertions below pin, and why the closure clause in `stillSignedInCopy` is the only
    // statement the parent gets on this path.
    expect(text(await within(card).findByRole('alert'))).toMatch(
      /you are still signed in on this computer/i,
    );
    expect(card.textContent).toMatch(/your PencilLift account is closed/i);
    expect(attempted).toBe(1);
    // No navigation, so nothing anywhere claims this computer is signed out.
    expect(screen.queryByText(/deletion page:/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/this computer is signed out/i);
    // And the SUCCESS outcome is gone too. Its copy ends "and this device is signed out" — the same
    // untrue half, in the word the copy actually uses, which is why the assertion above (looking for
    // "computer") left the flow's `action.setOutcome(null)` unpinned: deleting that line kept every
    // case here green. Asserted against the contract string itself so it cannot drift, and NOT over
    // the whole body loosely: the section's intro legitimately describes what closing will do, in
    // nearly the same words, before the parent does it.
    for (const line of Object.values(ACCOUNT_CLOSE_OUTCOME_COPY)) {
      expect(document.body.textContent).not.toContain(line.full);
    }
  });

  it('[HUNT5-N6] still reports the refusal when the thrown sign-out did clear this browser', async () => {
    let attempted = 0;
    let cleared = false;
    const auth: AuthAdapter = {
      configured: true,
      currentSession: () =>
        Promise.resolve(
          cleared ? null : { accessToken: 'test-token', email: 'parent@example.test' },
        ),
      signOut: () => {
        attempted += 1;
        cleared = true;
        return Promise.reject(new Error('auth server refused the sign-out'));
      },
    };
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: closed')).toBeTruthy();
    // This computer really is signed out, and the server was never told: both halves are true.
    expect(await screen.findByText('sign-out report: server not told')).toBeTruthy();
    expect(attempted).toBe(1);
  });

  it('says the sign-out was carried out when the adapter reports nothing', async () => {
    const { auth, count } = signOutCounter();
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('sign-out report: carried out')).toBeTruthy();
    expect(count()).toBe(1);
  });

  it('a family owner is told to delete the family account first (409 rule), and nothing signs out', async () => {
    let signedOut = 0;
    const { api } = fakeApi({
      send: () =>
        new ApiRequestError(
          'CONFLICT',
          'Delete your whole family account first',
          409,
          'FAMILY_DELETION_REQUIRED',
        ),
    });
    renderPage(<PrivacyControlsPage />, {
      api,
      auth: {
        configured: true,
        currentSession: () =>
          Promise.resolve({ accessToken: 'test-token', email: 'parent@example.test' }),
        signOut: () => {
          signedOut += 1;
          return Promise.resolve();
        },
      },
    });
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(text(await within(card).findByRole('alert'))).toMatch(
      /delete your whole family account first, then delete your account/i,
    );
    expect(signedOut).toBe(0);
    // The family deletion form is still on the page for them to use.
    expect(screen.getByRole('group', { name: /delete your whole family account/i })).toBeTruthy();
  });

  it('asks for the parent PIN when deleting the account needs a step-up', async () => {
    const { api } = fakeApi({ send: () => stepUp() });
    renderPage(<PrivacyControlsPage />, { api });
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await within(card).findByRole('group', { name: /enter your parent pin/i })).toBeTruthy();
  });

  it('the owner can still delete their account after the family was deleted, from the deleted-account state', async () => {
    const { auth, count } = signOutCounter();
    const { api, sends } = fakeApi({
      family: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      exports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      reports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      deletion: { requests: [deletion('family')] },
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    await screen.findByRole('heading', { name: /your family account is being deleted/i });
    const card = screen.getByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await screen.findByText('deletion page: pending')).toBeTruthy();
    expect(count()).toBe(1);
    expect(sends).toEqual([{ method: 'POST', path: '/v1/account/close', body: { confirm: true } }]);
  });

  it('an adult without a family can delete their sign-in too', async () => {
    const { api } = fakeApi({
      family: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      exports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
      reports: new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
    });
    renderPage(<PrivacyControlsPage />, { api });
    await screen.findByText(/there is no family on this account yet/i);
    expect(screen.getByRole('region', { name: /delete my account/i })).toBeTruthy();
  });

  it('asks a signed-out visitor to sign in and calls nothing', async () => {
    const { api, gets } = fakeApi();
    renderPage(<PrivacyControlsPage />, {
      api,
      auth: {
        configured: true,
        currentSession: () => Promise.resolve(null),
        signOut: () => Promise.resolve(),
      },
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/please sign in/i));
    await waitFor(() => expect(gets).toEqual([]));
  });

  /**
   * HUNT5-F-8, second half: the closure flow hands /account-deletion `signOutRefused`, and that page
   * rendered nothing for it — a parent whose sign-out the auth service refused was told the account is
   * closed and this device signed out, and nothing at all about the session that may still be usable
   * elsewhere. SignOutControl tells a parent exactly this on its own path; the same fact reaches them
   * here. Asserted on the real public page, not the stub, because the stub can only echo the state.
   *
   * HUNT6-G-6: two cases now, because the two closure outcomes do not offer the same remedy. On
   * `pending` the sign-in is genuinely still open until the family purge finishes, so a password
   * change is something the parent can carry out; on `closed` there is no sign-in left to change a
   * password on. HUNT6-F-1: neither one tells them to sign out on their phone — every sign-out in
   * this product is scope 'local', so that cannot touch this session.
   */
  it('[HUNT6-G-6] the public page names a remedy the parent can carry out while the sign-in is still open', async () => {
    const { auth } = reportedRefusal({ cleared: true });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'after_family_purge', signOut: true }
          : new Error('nope'),
    });
    renderWithRealDeletionPage(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    // Waiting for the public page's own heading first: the privacy page's action outcome carries the
    // same closure sentence in its own role="status" line, so a bare findByRole would read that one.
    await screen.findByRole('heading', { level: 1, name: /delete your PencilLift account/i });
    const notice = screen.getByRole('status');
    // The closure itself is still reported, in its own words — and in the sentence for the cause the
    // route gave, not in whichever one comes first (HUNT7-E-1).
    expect(notice.textContent).toContain(ACCOUNT_CLOSE_OUTCOME_COPY.after_family_purge.full);
    // And the session fact, in the exact shared string rather than a paraphrase of it (L-054).
    expect(notice.textContent).toContain(SIGN_OUT_NOT_TOLD_COPY.signInOpen);
    // HUNT6-F-1: the one remedy that cannot work is not offered, here or anywhere on the page.
    expect(document.body.textContent).not.toMatch(/on your phone/i);
  });

  it('[HUNT6-G-6] the public page asks for nothing once the sign-in itself is closed', async () => {
    const { auth } = reportedRefusal({ cleared: true });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithRealDeletionPage(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    await screen.findByRole('heading', { level: 1, name: /delete your PencilLift account/i });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain(ACCOUNT_CLOSE_COPY.closed);
    expect(notice.textContent).toContain(SIGN_OUT_NOT_TOLD_COPY.signInClosed);
    // The account is gone, so neither remedy exists: no password to change, no sign-in to end.
    expect(notice.textContent).not.toMatch(/change your password/i);
    expect(document.body.textContent).not.toMatch(/on your phone/i);
  });

  /**
   * HUNT7-E-1. PREMISE: `pending` is answered for two different events, and only one of them is a family
   * purge. POST /v1/account/close answers `pending` for a guardian (or an adult with no family)
   * whenever `closeNow` could not close the sign-in — the route's own header says so and
   * apps/api/tests/account-close.test.ts covers it under 'guardian path when the auth service refuses'.
   * That parent has no family deletion to wait for: leaving the family revokes their membership and the
   * family stays live with its owner. Told that their sign-in "closes automatically once your family
   * account's deletion has finished", the only reading available to them is that nothing will close it,
   * and the thing that actually will (the queued `account_close` job retrying) was never named. The
   * route now says which cause it is, and each surface prints that cause's sentence.
   */
  it('[repro] [HUNT7-E-1] the public page says why a retried closure is pending, not that a deletion must finish', async () => {
    const { auth } = signOutCounter();
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'retrying', signOut: true }
          : new Error('nope'),
    });
    renderWithRealDeletionPage(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    await screen.findByRole('heading', { level: 1, name: /delete your PencilLift account/i });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain(ACCOUNT_CLOSE_OUTCOME_COPY.retrying.full);
    expect(notice.textContent).toMatch(/could not finish closing your sign-in/i);
    expect(notice.textContent).not.toMatch(/family account/i);
  });

  it('[repro] [HUNT7-E-1] the portal says it too, in the window before the device sign-out answers', async () => {
    // The parent reads this screen's own notice for as long as the device sign-out takes (three
    // network calls at the adapter's timeout), so the cause has to be right here as well as on the
    // page the flow lands on — and the handover value is the one /account-deletion reads for THIS
    // cause, not the owner's.
    let release = () => undefined as void;
    const signedOut = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const auth: AuthAdapter = {
      configured: true,
      currentSession: () =>
        Promise.resolve({ accessToken: 'test-token', email: 'parent@example.test' }),
      signOut: () => signedOut,
    };
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'retrying', signOut: true }
          : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    expect(await within(card).findByText(ACCOUNT_CLOSE_OUTCOME_COPY.retrying.full)).toBeTruthy();
    release();
    expect(await screen.findByText('deletion page: pending_retry')).toBeTruthy();
  });

  it('[repro] [HUNT7-E-1] and says it here too when the session survived the sign-out', async () => {
    // The path that stays on the portal restates the closure in its own words (`stillSignedInCopy`),
    // so it is a second place the cause can be got wrong.
    const { auth } = reportedRefusal({ cleared: false });
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close'
          ? { status: 'pending', reason: 'retrying', signOut: true }
          : new Error('nope'),
    });
    renderWithDeletionRoute(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    const alert = text(await within(card).findByRole('alert'));
    expect(alert).toMatch(/you are still signed in on this computer/i);
    expect(alert).toContain(ACCOUNT_CLOSE_OUTCOME_COPY.retrying.serverOnly);
    expect(alert).not.toMatch(/family account/i);
    expect(screen.queryByText(/deletion page:/)).toBeNull();
  });

  it('[HUNT5-F-8] says nothing about the session when the sign-out was carried out', async () => {
    const { auth } = signOutCounter();
    const { api } = fakeApi({
      send: (call) =>
        call.path === '/v1/account/close' ? { status: 'closed', signOut: true } : new Error('nope'),
    });
    renderWithRealDeletionPage(api, auth);
    const card = await screen.findByRole('region', { name: /delete my account/i });
    await userEvent.click(within(card).getByRole('checkbox', { name: /i understand my sign-in/i }));
    await userEvent.click(within(card).getByRole('button', { name: /delete my account/i }));
    await screen.findByRole('heading', { level: 1, name: /delete your PencilLift account/i });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/your PencilLift account is closed/i);
    // The refusal sentence is for the refusal path only: the normal path must not raise the alarm.
    expect(notice.textContent).not.toMatch(/could not tell PencilLift’s servers/i);
    expect(document.body.textContent).not.toContain(SIGN_OUT_NOT_TOLD_COPY.signInOpen);
    expect(document.body.textContent).not.toContain(SIGN_OUT_NOT_TOLD_COPY.signInClosed);
  });
});

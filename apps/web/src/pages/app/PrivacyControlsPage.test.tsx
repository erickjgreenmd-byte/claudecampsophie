import { cleanup, screen, waitFor, within } from '@testing-library/react';
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
import { PARENT_SAFETY_FLAG_COPY } from '@pencillift/contracts';
import { renderPage } from '../../test/render.tsx';
import PrivacyControlsPage from './PrivacyControlsPage.tsx';

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
    expect(
      screen.getAllByText(/does not cancel an app store or google play subscription/i),
    ).not.toHaveLength(0);
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
          return { unlockedUntil: '2026-09-24T15:05:00.000Z' };
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
    // The stale family controls are gone, not kept on screen from the last good load.
    expect(screen.queryByRole('region', { name: /export your data/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
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
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /request export/i })).toBeNull();
    expect(
      screen.getAllByText(/does not cancel an app store or google play subscription/i),
    ).not.toHaveLength(0);
  });

  it('lists family safety reports with who reported them and their status', async () => {
    const reports: SafetyReports = {
      reports: [
        {
          id: REPORT_A,
          reporterKind: 'child',
          category: 'answer_revealed',
          childId: RILEY,
          questionId: null,
          note: null,
          status: 'open',
          createdAt: '2026-09-23T15:00:00.000Z',
          triagedAt: null,
          resolvedAt: null,
        },
        {
          id: REPORT_B,
          reporterKind: 'parent',
          category: 'wrong_or_confusing',
          childId: SAM,
          questionId: null,
          note: 'The hint did not match the worksheet.',
          status: 'resolved',
          createdAt: '2026-09-22T15:00:00.000Z',
          triagedAt: '2026-09-22T16:00:00.000Z',
          resolvedAt: '2026-09-22T17:00:00.000Z',
        },
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
    expect(text(items[1])).toMatch(/reported by a parent/i);
    expect(text(items[1])).toMatch(/resolved/i);
    expect(text(items[1])).toMatch(/did not match the worksheet/i);
  });

  it('shows a safety-screen flag honestly, with resources and no alert claim (AC_SECURITY_02)', async () => {
    const QUESTION = 'e29e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';
    const reports: SafetyReports = {
      reports: [
        {
          id: REPORT_A,
          reporterKind: 'system',
          category: 'severe_risk',
          childId: RILEY,
          questionId: QUESTION,
          note: null,
          status: 'escalated',
          createdAt: '2026-09-23T15:00:00.000Z',
          triagedAt: null,
          resolvedAt: null,
        },
      ],
    };
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
    expect(content).toMatch(/pencillift sent no automatic alert/i);
    // It says what the product shows, not what the child saw (opening results is not recorded).
    expect(content).not.toMatch(/your child saw/i);
    expect(content).toMatch(/988/);
    expect(content).toMatch(/1-800-422-4453/);
    expect(content).toMatch(/911/);
    // Never claims a delivery, and never names the kind of concern the word match suggested.
    expect(content.replace(/sent no automatic alert/i, '')).not.toMatch(
      /alerted|notified|we (?:emailed|texted|sent)/i,
    );
    // (The resources line names the hotlines; that is not about this report.)
    expect(content.replace(PARENT_SAFETY_FLAG_COPY.resources, '')).not.toMatch(
      /self-harm|suicid|abuse|sexual|violen/i,
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
    // Honest about held reports (runbook 5.1) without saying whether one exists.
    expect(text(section)).toMatch(/some flags appear here only after that review/i);
    expect(text(section)).toMatch(/pencillift sends no automatic alert/i);
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
        report: {
          id: REPORT_A,
          reporterKind: 'parent',
          category: 'unsafe_content',
          childId: null,
          questionId: null,
          note: 'Tone felt wrong.',
          status: 'open',
          createdAt: '2026-09-24T15:00:00.000Z',
          triagedAt: null,
          resolvedAt: null,
        },
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
});

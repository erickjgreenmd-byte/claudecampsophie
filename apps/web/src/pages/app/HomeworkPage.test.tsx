import { createHash } from 'node:crypto';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  AssignmentDetailResponse,
  AssignmentListResponse,
  AssignmentSolutionsResponse,
  AssignmentSummary,
  ParentQuestion,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import HomeworkPage from './HomeworkPage.tsx';

// Synthetic data only (Riley, Sam).
const FAMILY = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const READY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RESCAN = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const REVIEW = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';
const RETRY = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';
const FINAL = 'cf7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d0e';
const QUEUED = 'd08d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e1f';
const Q1 = 'e19e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f2a';
const Q2 = 'f2af1a2b-3c4d-4e5f-8a7b-8c9d0e1f2a3b';
const PAGE = '03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c';
const AT = '2026-09-20T15:00:00.000Z';

function summary(
  id: string,
  status: AssignmentSummary['status'],
  childId = RILEY,
): AssignmentSummary {
  return {
    id,
    childId,
    subjectId: null,
    status,
    pageCount: 2,
    createdByKind: 'child',
    errorCode: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

const family = {
  id: FAMILY,
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 2,
  billingConflict: null,
  managingChannel: 'app_store',
  children: [
    { id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' },
    { id: SAM, nickname: 'Sam', gradeLevel: 1, ageBand: '5-7', status: 'active' },
  ],
};

function list(childId = RILEY): AssignmentListResponse {
  return {
    assignments:
      childId === RILEY
        ? [
            summary(READY, 'ready'),
            summary(RESCAN, 'needs_rescan'),
            summary(REVIEW, 'needs_parent_review'),
            summary(RETRY, 'failed_retryable'),
            summary(FINAL, 'failed_final'),
            summary(QUEUED, 'queued'),
          ]
        : [],
    allowance: {
      periodKey: 'pages:2026-09',
      childPagesUsed: 12,
      childPagesAllowed: 40,
      familyPagesUsed: 20,
      familyPagesAllowed: 80,
    },
  };
}

function question(overrides: Partial<ParentQuestion> = {}): ParentQuestion {
  return {
    id: Q1,
    pageNumber: 1,
    questionNumber: '1',
    promptText: 'What is 3/4 + 1/8?',
    studentAnswerText: '4/12',
    correctedPromptText: null,
    correctedStudentAnswerText: null,
    correctedAt: null,
    answerKind: 'numeric',
    subjectKey: 'math',
    skill: 'fraction_addition',
    uncertainty: 'high',
    result: {
      verdict: 'incorrect',
      gradedVerdict: 'incorrect',
      route: 'escalated',
      disagreement: true,
      gradedAt: AT,
      override: null,
    },
    ...overrides,
  };
}

function detail(questions: ParentQuestion[] = [question()]): AssignmentDetailResponse {
  return {
    assignment: summary(READY, 'ready'),
    pages: [{ id: PAGE, pageNumber: 1, mimeType: 'image/jpeg' }],
    questions: [
      ...questions,
      question({
        id: Q2,
        questionNumber: '2',
        promptText: 'What is 2 + 5?',
        studentAnswerText: '7',
        uncertainty: 'low',
        result: {
          verdict: 'correct',
          gradedVerdict: 'correct',
          route: 'deterministic',
          disagreement: false,
          gradedAt: AT,
          override: null,
        },
      }),
    ],
  };
}

const solutions: AssignmentSolutionsResponse = {
  assignmentId: READY,
  solutions: [
    {
      questionId: Q1,
      questionNumber: '1',
      correctAnswer: '7/8',
      workedSolution: 'Rewrite 3/4 as 6/8, then add 1/8 to get 7/8.',
      rubric: null,
      misconception: 'Added numerators and denominators separately.',
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(
  options: {
    get?: (path: string) => unknown;
    send?: (call: Call) => unknown;
    /** Simulated network latency for GETs (a real reload renders its loading state). */
    latencyMs?: number;
  } = {},
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const defaultGet = (path: string): unknown => {
    if (path === '/v1/family') return family;
    if (path.startsWith('/v1/assignments?childId=')) return list(path.split('=')[1]);
    if (path === `/v1/assignments/${READY}`) return detail();
    return new Error(`unexpected GET ${path}`);
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = options.get?.(path) ?? defaultGet(path);
        if (value instanceof Error) return Promise.reject(value);
        if (options.latencyMs) {
          return new Promise<void>((resolve) => setTimeout(resolve, options.latencyMs)).then(() =>
            schema.parse(value),
          );
        }
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    send: <S extends z.ZodType>(
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body: unknown,
      schema: S,
    ) => {
      const call = { method, path, body };
      sends.push(call);
      try {
        const value = options.send?.(call);
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(schema.parse(value));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
  return { api, gets, sends };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stepUp = () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403);

async function openReadyScan() {
  const scans = await screen.findByRole('region', { name: 'Scans' });
  await userEvent.click(within(scans).getAllByRole('button', { name: /Open scan/ })[0]!);
  return screen.findByRole('region', { name: 'Scan details' });
}

describe('HomeworkPage (spec P5, P6, P14; AC_UX_02, AC_GRADING_05, AC_GRADING_10)', () => {
  it('lists a child’s scans with every processing state explained honestly', async () => {
    const { api, gets } = fakeApi();
    renderPage(<HomeworkPage />, { api });
    expect(await screen.findByRole('heading', { name: 'Homework' })).toBeTruthy();
    const scans = await screen.findByRole('region', { name: 'Scans' });
    expect(gets).toContain(`/v1/assignments?childId=${RILEY}`);
    expect(within(scans).getByText(/Results are ready/)).toBeTruthy();
    expect(within(scans).getByText(/hard to read/i)).toBeTruthy();
    expect(within(scans).getByText(/need your review/i)).toBeTruthy();
    expect(within(scans).getByText(/temporary problem/i)).toBeTruthy();
    expect(within(scans).getByText(/could not be processed/i)).toBeTruthy();
    expect(within(scans).getByText(/Waiting to be read/)).toBeTruthy();
    // The page allowance is shown with in-flight scans included.
    expect(screen.getByText(/12 of 40 pages used this month/)).toBeTruthy();
    // Only states that can be cancelled offer a cancel button.
    expect(within(scans).getAllByRole('button', { name: /Cancel scan/ })).toHaveLength(3);
  });

  it('switching child loads that child’s scans and shows an honest empty state', async () => {
    const { api, gets } = fakeApi();
    renderPage(<HomeworkPage />, { api });
    await screen.findByRole('region', { name: 'Scans' });
    await userEvent.selectOptions(screen.getByLabelText('Child'), SAM);
    expect(await screen.findByText(/No scans for Sam yet/)).toBeTruthy();
    expect(gets).toContain(`/v1/assignments?childId=${SAM}`);
    const scans = screen.getByRole('region', { name: 'Scans' });
    expect(within(scans).getByText(/paired phone or tablet/)).toBeTruthy();
  });

  it('shows loading, then an error with a working retry', async () => {
    let fail = true;
    const { api, gets } = fakeApi({
      get: (path) =>
        path.startsWith('/v1/assignments?') && fail
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : undefined,
    });
    renderPage(<HomeworkPage />, { api });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Scans' })).toBeTruthy();
    expect(gets.filter((p) => p.startsWith('/v1/assignments?'))).toHaveLength(2);
  });

  it('detail shows the student’s answers and verdicts as text, never solutions by default', async () => {
    const { api } = fakeApi();
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    expect(within(panel).getByText('What is 3/4 + 1/8?')).toBeTruthy();
    expect(within(panel).getByText('4/12')).toBeTruthy();
    expect(within(panel).getByText(/Incorrect/)).toBeTruthy();
    expect(within(panel).getByText(/Correct/)).toBeTruthy();
    expect(within(panel).getByText(/checkers disagreed/i)).toBeTruthy();
    expect(within(panel).getByText(/hard to read \(high\)/i)).toBeTruthy();
    expect(within(panel).queryByText('7/8')).toBeNull();
  });

  it('solutions ask for the parent PIN when the step-up is missing, then show once unlocked', async () => {
    let unlocked = false;
    const { api, gets } = fakeApi({
      get: (path) => (path.endsWith('/solutions') ? (unlocked ? solutions : stepUp()) : undefined),
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    expect(await within(panel).findByText(/Enter your parent PIN/)).toBeTruthy();
    expect(
      within(panel)
        .getByRole('link', { name: /Security page/ })
        .getAttribute('href'),
    ).toBe('/app/security');
    expect(within(panel).queryByText('7/8')).toBeNull();
    unlocked = true;
    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    expect(await within(panel).findByText('7/8')).toBeTruthy();
    expect(within(panel).getByText(/Rewrite 3\/4 as 6\/8/)).toBeTruthy();
    expect(gets.filter((p) => p.endsWith('/solutions'))).toHaveLength(2);
    await userEvent.click(within(panel).getByRole('button', { name: 'Hide solutions' }));
    expect(within(panel).queryByText('7/8')).toBeNull();
  });

  it('an override needs a reason and posts the verdict, then refreshes', async () => {
    const { api, sends, gets } = fakeApi({
      send: (call) => ({
        questionId: Q1,
        result: {
          verdict: (call.body as { verdict: 'correct' }).verdict,
          gradedVerdict: 'incorrect',
          route: 'escalated',
          disagreement: true,
          gradedAt: AT,
          override: { verdict: 'correct', reason: 'Equivalent answer', at: AT },
        },
      }),
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const q1 = within(panel).getByRole('article', { name: 'Question 1' });
    await userEvent.click(within(q1).getByRole('button', { name: 'Change result' }));
    const save = within(q1).getByRole('button', { name: 'Save result' });
    await userEvent.click(save);
    expect(await within(q1).findByText(/Add a short reason/)).toBeTruthy();
    expect(sends).toHaveLength(0);
    await userEvent.selectOptions(within(q1).getByLabelText('New result'), 'correct');
    await userEvent.type(within(q1).getByLabelText('Reason'), 'Equivalent answer');
    await userEvent.click(save);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/questions/${Q1}/override`,
      body: { verdict: 'correct', reason: 'Equivalent answer' },
    });
    expect(await screen.findByText(/Result updated/)).toBeTruthy();
    await waitFor(() =>
      expect(gets.filter((p) => p === `/v1/assignments/${READY}`)).toHaveLength(2),
    );
  });

  it('an override without a step-up explains how to unlock', async () => {
    const { api } = fakeApi({ send: () => stepUp() });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const q1 = within(panel).getByRole('article', { name: 'Question 1' });
    await userEvent.click(within(q1).getByRole('button', { name: 'Change result' }));
    await userEvent.type(within(q1).getByLabelText('Reason'), 'Equivalent answer');
    await userEvent.click(within(q1).getByRole('button', { name: 'Save result' }));
    expect(await within(q1).findByText(/Enter your parent PIN/)).toBeTruthy();
  });

  it('a transcription fix sends only the changed text and says it is re-checking', async () => {
    const corrected = question({ correctedStudentAnswerText: '7/8', correctedAt: AT });
    const { api, sends } = fakeApi({
      send: () => ({
        assignment: {
          id: READY,
          subjectId: null,
          status: 'checking',
          pageCount: 2,
          createdAt: AT,
          updatedAt: AT,
        },
        question: corrected,
      }),
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const q1 = within(panel).getByRole('article', { name: 'Question 1' });
    await userEvent.click(within(q1).getByRole('button', { name: 'Fix transcription' }));
    const answer = within(q1).getByLabelText('Student answer as written');
    await userEvent.clear(answer);
    await userEvent.type(answer, '7/8');
    await userEvent.click(within(q1).getByRole('button', { name: 'Save transcription' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/questions/${Q1}/correction`,
      body: { studentAnswerText: '7/8' },
    });
    expect(await screen.findByText(/re-checking/i)).toBeTruthy();
  });

  it('shows original and corrected transcriptions side by side', async () => {
    const { api } = fakeApi({
      get: (path) =>
        path === `/v1/assignments/${READY}`
          ? detail([question({ correctedStudentAnswerText: '7/8', correctedAt: AT })])
          : undefined,
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const q1 = within(panel).getByRole('article', { name: 'Question 1' });
    expect(within(q1).getByText('4/12')).toBeTruthy();
    expect(within(q1).getByText(/Corrected by a parent/)).toBeTruthy();
    expect(within(q1).getByText('7/8')).toBeTruthy();
  });

  it('cancelling a queued scan posts the cancel and reloads the list', async () => {
    const { api, sends, gets } = fakeApi({
      send: () => ({
        assignment: {
          id: QUEUED,
          subjectId: null,
          status: 'cancelled',
          pageCount: 2,
          createdAt: AT,
          updatedAt: AT,
        },
      }),
    });
    renderPage(<HomeworkPage />, { api });
    const scans = await screen.findByRole('region', { name: 'Scans' });
    const buttons = within(scans).getAllByRole('button', { name: /Cancel scan/ });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ method: 'POST', path: `/v1/assignments/${QUEUED}/cancel` });
    expect(await screen.findByText(/Scan cancelled/)).toBeTruthy();
    await waitFor(() =>
      expect(gets.filter((p) => p.startsWith('/v1/assignments?'))).toHaveLength(2),
    );
  });

  it('explains a used-up page allowance without offering a purchase', async () => {
    const { api } = fakeApi({
      get: (path) =>
        path.startsWith('/v1/assignments?')
          ? {
              ...list(),
              allowance: {
                periodKey: 'pages:2026-09',
                childPagesUsed: 40,
                childPagesAllowed: 40,
                familyPagesUsed: 40,
                familyPagesAllowed: 80,
              },
            }
          : undefined,
    });
    renderPage(<HomeworkPage />, { api });
    expect(await screen.findByText(/allowance for this month is used up/i)).toBeTruthy();
    expect(screen.getByText(/existing homework and results stay available/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /buy|purchase|upgrade/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Parent scan uploader (spec P5 "Parent selects child", P14 "scan uploader"; RV-homework-9)
// ---------------------------------------------------------------------------------------------

const NEW_SCAN = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PAGE_IDS = ['2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f'];

function state(status: AssignmentSummary['status'], pageCount = 2) {
  return {
    assignment: {
      id: NEW_SCAN,
      subjectId: null,
      status,
      pageCount,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

function file(name: string, type: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Server responses for the capture routes; `create` decides what POST /v1/assignments returns. */
function captureSend(create: () => unknown = () => state('draft')) {
  return (call: Call): unknown => {
    if (call.path === '/v1/assignments') return create();
    if (call.path.endsWith('/uploads')) {
      const pages = (call.body as { pages: { pageNumber: number }[] }).pages;
      return {
        ...state('uploading', pages.length),
        uploads: pages.map((p, i) => ({
          pageId: PAGE_IDS[i],
          pageNumber: p.pageNumber,
          uploadUrl: `https://storage.example.test/upload/${p.pageNumber}?token=t`,
          method: 'PUT',
          expiresAt: AT,
          alreadyUploaded: false,
        })),
      };
    }
    if (call.path.endsWith('/finalize')) return state('queued');
    if (call.path.endsWith('/cancel')) return state('cancelled');
    return new Error(`unexpected ${call.method} ${call.path}`);
  };
}

/** Records PUTs to signed URLs (stands in for the browser's fetch). */
function stubStorage(respond: () => Promise<Response> = () => Promise.resolve(new Response(null))) {
  const puts: { url: string; method: string; type: string; body: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      puts.push({
        url,
        method: init.method ?? 'GET',
        type: new Headers(init.headers).get('content-type') ?? '',
        body: new TextDecoder().decode(init.body as Uint8Array),
      });
      return respond();
    }),
  );
  return puts;
}

async function openUploader() {
  const card = await screen.findByRole('region', { name: 'Add a scan' });
  await userEvent.click(within(card).getByRole('button', { name: 'Add a scan for Riley' }));
  return card;
}

describe('parent scan uploader (spec P5, P14; RV-homework-9)', () => {
  it('shows the limits first, lets the parent order pages, then creates, uploads and finalizes a scan', async () => {
    const puts = stubStorage();
    const { api, sends, gets } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    // Limits and the unavailable types are visible before anything is chosen (spec P5).
    expect(within(card).getByText(/Up to 10 pages per scan, each 15 MB or smaller/)).toBeTruthy();
    expect(within(card).getByText(/Not available yet:/).parentElement!.textContent).toMatch(
      /HEIC photos and PDF study guides/,
    );
    const input = within(card).getByLabelText<HTMLInputElement>('Choose page photos');
    expect(input.accept).toBe('image/jpeg,image/png');
    // PDF import is not offered until the converter ships (AC_CAPTURE_01, AC_UX_02).
    expect(within(card).queryByRole('button', { name: /pdf/i })).toBeNull();
    expect(within(card).queryByLabelText(/pdf/i)).toBeNull();
    await userEvent.upload(input, [
      file('first.jpg', 'image/jpeg', 'first page'),
      file('second.png', 'image/png', 'second page'),
    ]);
    const list = within(card).getByRole('list', { name: 'Pages to send' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Page 1: first.jpg'),
      expect.stringContaining('Page 2: second.png'),
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Move page 2 up' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Send 2 pages' }));
    expect(await within(card).findByText(/Sent! Riley’s scan is waiting to be read/)).toBeTruthy();

    expect(sends.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/assignments',
      `POST /v1/assignments/${NEW_SCAN}/uploads`,
      `POST /v1/assignments/${NEW_SCAN}/finalize`,
    ]);
    // The parent names the selected child; the server checks it belongs to the family.
    expect(sends[0]!.body).toMatchObject({ childId: RILEY, pageCount: 2 });
    expect((sends[1]!.body as { pages: unknown[] }).pages).toEqual([
      { pageNumber: 1, mimeType: 'image/png', byteSize: 11, sha256: sha('second page') },
      { pageNumber: 2, mimeType: 'image/jpeg', byteSize: 10, sha256: sha('first page') },
    ]);
    // Bytes go straight to private storage with signed URLs, in the chosen order.
    expect(puts).toEqual([
      {
        url: 'https://storage.example.test/upload/1?token=t',
        method: 'PUT',
        type: 'image/png',
        body: 'second page',
      },
      {
        url: 'https://storage.example.test/upload/2?token=t',
        method: 'PUT',
        type: 'image/jpeg',
        body: 'first page',
      },
    ]);
    // The scan list reloads so the new scan appears.
    await waitFor(() =>
      expect(gets.filter((p) => p.startsWith('/v1/assignments?'))).toHaveLength(2),
    );
  });

  it('refuses unreadable or oversized files before sending anything', async () => {
    stubStorage();
    const { api, sends } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    const user = userEvent.setup({ applyAccept: false }); // "All files" in the picker
    await user.upload(within(card).getByLabelText('Choose page photos'), [
      file('guide.pdf', 'application/pdf', '%PDF-1.7'),
    ]);
    expect(within(card).getByText(/guide.pdf isn’t a JPEG or PNG photo/)).toBeTruthy();
    const sendButton = within(card).getByRole<HTMLButtonElement>('button', { name: 'Send 1 page' });
    expect(sendButton.disabled).toBe(true);
    await user.click(within(card).getByRole('button', { name: 'Remove page 1' }));
    expect(within(card).queryByRole('list', { name: 'Pages to send' })).toBeNull();
    expect(sends).toHaveLength(0);
  });

  it('a retry after a lost finalize response reports the already-queued scan as sent', async () => {
    const puts = stubStorage();
    let finalizeLost = true;
    let createStatus: AssignmentSummary['status'] = 'draft';
    const send = captureSend(() => state(createStatus));
    const { api, sends } = fakeApi({
      send: (call) => {
        if (call.path.endsWith('/finalize') && finalizeLost) {
          // The server committed the finalize, but the response never arrived.
          finalizeLost = false;
          createStatus = 'queued';
          return new ApiRequestError('NETWORK', 'You appear to be offline.', 0);
        }
        return send(call);
      },
    });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    await userEvent.upload(within(card).getByLabelText('Choose page photos'), [
      file('page.jpg', 'image/jpeg', 'only page'),
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Send 1 page' }));
    expect((await within(card).findByRole('alert')).textContent).toMatch(/offline/);
    await userEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await within(card).findByText(/Sent!/)).toBeTruthy();
    // Same create key both times; the retry never registers pages again.
    expect(sends.map((c) => c.path)).toEqual([
      '/v1/assignments',
      `/v1/assignments/${NEW_SCAN}/uploads`,
      `/v1/assignments/${NEW_SCAN}/finalize`,
      '/v1/assignments',
    ]);
    expect(sends[3]!.body).toEqual(sends[0]!.body);
    expect(puts).toHaveLength(1);
  });

  it('stop sending cancels the unfinished scan so its pages are released', async () => {
    let release: () => void = () => undefined;
    stubStorage(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(null));
        }),
    );
    const { api, sends } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    await userEvent.upload(within(card).getByLabelText('Choose page photos'), [
      file('a.jpg', 'image/jpeg', 'a'),
      file('b.jpg', 'image/jpeg', 'b'),
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Send 2 pages' }));
    expect(await within(card).findByText(/Uploading page 1 of 2/)).toBeTruthy();
    expect(within(card).getByRole('progressbar', { name: 'Upload progress' })).toBeTruthy();
    // While sending, the uploader cannot be closed or the pages changed.
    expect(
      within(card).getByRole<HTMLButtonElement>('button', { name: 'Close the uploader' }).disabled,
    ).toBe(true);
    await userEvent.click(within(card).getByRole('button', { name: 'Stop sending' }));
    release();
    expect((await within(card).findByRole('alert')).textContent).toMatch(
      /Stopped. Your pages are still selected/,
    );
    expect(sends.map((c) => c.path)).toEqual([
      '/v1/assignments',
      `/v1/assignments/${NEW_SCAN}/uploads`,
      `/v1/assignments/${NEW_SCAN}/cancel`,
    ]);
  });

  it('explains why new scans can’t start instead of offering an uploader that would fail', async () => {
    // A draft child (no paid slot yet): the reason and where to fix it, never a purchase button.
    const { api } = fakeApi({
      get: (path) =>
        path === '/v1/family'
          ? { ...family, children: [{ ...family.children[0]!, status: 'draft' }] }
          : undefined,
    });
    renderPage(<HomeworkPage />, { api });
    const card = await screen.findByRole('region', { name: 'Add a scan' });
    expect(
      within(card).getByText(/needs a paid child slot before homework can be scanned/),
    ).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Children page' })).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
    cleanup();

    // A downgrade released Riley's slot: the allowance card says so; scanning is paused.
    const released = fakeApi({
      get: (path) =>
        path.startsWith('/v1/assignments?')
          ? {
              ...list(),
              allowance: { ...list().allowance!, childHasPaidSlot: false },
            }
          : undefined,
    });
    renderPage(<HomeworkPage />, { api: released.api });
    const allowance = await screen.findByRole('region', { name: 'Page allowance' });
    expect(within(allowance).getByText(/doesn’t hold a paid child slot right now/)).toBeTruthy();
    expect(within(allowance).queryByText(/used up/i)).toBeNull();
    const paused = screen.getByRole('region', { name: 'Add a scan' });
    expect(within(paused).getByText(/New scans for Riley are paused/)).toBeTruthy();
    expect(within(paused).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /buy|purchase|upgrade/i })).toBeNull();
  });
});

/**
 * Stands in for the browser measuring a picked photo's natural size (jsdom never loads images).
 * `hold` keeps every measurement pending until `release()`.
 */
function stubImageSizes(
  sizes: Record<string, { width: number; height: number }>,
  options: { hold?: boolean } = {},
) {
  const pending: (() => void)[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:test/${(blob as File).name}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  class FakeImage {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      const size = sizes[url.slice('blob:test/'.length)];
      const fire = () => {
        if (!size) {
          this.onerror?.();
          return;
        }
        this.naturalWidth = size.width;
        this.naturalHeight = size.height;
        this.onload?.();
      };
      if (options.hold) pending.push(fire);
      else queueMicrotask(fire);
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return { release: () => pending.splice(0).forEach((fire) => fire()) };
}

describe('picture size limits in the parent uploader (AC_CAPTURE_02)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the picture size limit and refuses an over-limit photo before sending anything', async () => {
    stubStorage();
    stubImageSizes({
      'huge.jpg': { width: 12_000, height: 9_000 },
      'page.png': { width: 4032, height: 3024 },
    });
    const { api, sends } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    expect(within(card).getByText(/photos of up to 60 megapixels/)).toBeTruthy();
    await userEvent.upload(within(card).getByLabelText('Choose page photos'), [
      file('huge.jpg', 'image/jpeg', 'huge'),
      file('page.png', 'image/png', 'page'),
    ]);
    expect(
      await within(card).findByText(
        'huge.jpg is too big a picture (12,000 × 9,000 pixels). Photos can be up to 10,000 pixels on each side and 60 megapixels; a photo at your camera’s usual size works.',
        { exact: false },
      ),
    ).toBeTruthy();
    const list = within(card).getByRole('list', { name: 'Pages to send' });
    expect(within(list).getAllByText(/too big a picture/)).toHaveLength(1);
    const sendButton = within(card).getByRole<HTMLButtonElement>('button', {
      name: 'Send 2 pages',
    });
    expect(sendButton.disabled).toBe(true);
    await userEvent.click(within(card).getByRole('button', { name: 'Remove page 1' }));
    expect(
      within(card).getByRole<HTMLButtonElement>('button', { name: 'Send 1 page' }).disabled,
    ).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it('a photo still being measured when Send is pressed is checked before the scan is created', async () => {
    const puts = stubStorage();
    const images = stubImageSizes(
      { 'bomb.png': { width: 50_000, height: 50_000 } },
      { hold: true },
    );
    const { api, sends } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    await userEvent.upload(within(card).getByLabelText('Choose page photos'), [
      file('bomb.png', 'image/png', 'tiny file, huge header'),
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Send 1 page' }));
    images.release();
    expect((await within(card).findByRole('alert')).textContent).toMatch(
      /bomb\.png is too big a picture \(50,000 × 50,000 pixels\)/,
    );
    expect(sends).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('a photo the browser can’t measure is left to the server’s check', async () => {
    const puts = stubStorage();
    stubImageSizes({}); // every measurement fails
    const { api, sends } = fakeApi({ send: captureSend() });
    renderPage(<HomeworkPage />, { api });
    const card = await openUploader();
    await userEvent.upload(within(card).getByLabelText('Choose page photos'), [
      file('page.jpg', 'image/jpeg', 'only page'),
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Send 1 page' }));
    expect(await within(card).findByText(/Sent!/)).toBeTruthy();
    expect(sends).toHaveLength(3);
    expect(puts).toHaveLength(1);
  });
});

describe('honest follow-up states (RV-homework-6, 7, 8)', () => {
  it('a scan that needs the file converter says so instead of asking for clearer photos', async () => {
    const { api } = fakeApi({
      get: (path) =>
        path.startsWith('/v1/assignments?')
          ? {
              ...list(),
              assignments: [
                { ...summary(FINAL, 'failed_final'), errorCode: 'FORMAT_NEEDS_CONVERSION' },
              ],
            }
          : undefined,
    });
    renderPage(<HomeworkPage />, { api });
    const scans = await screen.findByRole('region', { name: 'Scans' });
    expect(within(scans).getByText(/can’t read PDF or HEIC files yet/)).toBeTruthy();
    expect(within(scans).queryByText(/could not be processed after several tries/)).toBeNull();
  });

  it('the transcription-fix confirmation survives the refresh that follows it', async () => {
    const { api, gets } = fakeApi({
      latencyMs: 20,
      send: () => ({
        assignment: {
          id: READY,
          subjectId: null,
          status: 'checking',
          pageCount: 2,
          createdAt: AT,
          updatedAt: AT,
        },
        question: question({ correctedStudentAnswerText: '7/8', correctedAt: AT }),
      }),
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const q1 = await within(panel).findByRole('article', { name: 'Question 1' });
    await userEvent.click(within(q1).getByRole('button', { name: 'Fix transcription' }));
    const answer = within(q1).getByLabelText('Student answer as written');
    await userEvent.clear(answer);
    await userEvent.type(answer, '7/8');
    await userEvent.click(within(q1).getByRole('button', { name: 'Save transcription' }));
    await waitFor(() =>
      expect(gets.filter((p) => p === `/v1/assignments/${READY}`).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    expect(screen.getByText(/re-checking this question/)).toBeTruthy();
  });
});

describe('rubric feedback for written work (AC_GRADING_03)', () => {
  const WRITING = '36e35e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f';
  const writingQuestion = question({
    id: WRITING,
    questionNumber: '3',
    promptText: 'Write two sentences about your favourite season.',
    studentAnswerText: 'I like autumn. The leaves turn orange.',
    answerKind: 'writing',
    subjectKey: 'writing',
    skill: 'opinion_writing',
    uncertainty: 'low',
    result: {
      verdict: 'rubric',
      gradedVerdict: 'rubric',
      route: 'deterministic',
      disagreement: false,
      gradedAt: AT,
      override: null,
    },
  });
  // The shape the grader stores for writing (packages/ai gradingOutputSchema `rubric`).
  const writingSolution = {
    questionId: WRITING,
    questionNumber: '3',
    correctAnswer: '',
    workedSolution: '',
    rubric: [
      { criterion: 'Uses complete sentences', met: true, note: 'Both sentences are complete.' },
      { criterion: 'Gives a reason', met: false, note: 'Add one more reason for the choice.' },
    ],
    misconception: null,
  };
  function withWriting(rubric: unknown = writingSolution.rubric) {
    return fakeApi({
      get: (path) => {
        if (path === `/v1/assignments/${READY}`) return detail([question(), writingQuestion]);
        if (path.endsWith('/solutions')) {
          return {
            ...solutions,
            solutions: [...solutions.solutions, { ...writingSolution, rubric }],
          };
        }
        return undefined;
      },
    });
  }

  it('shows each rubric criterion with its feedback once solutions are unlocked, never before', async () => {
    const { api } = withWriting();
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    const article = await within(panel).findByRole('article', { name: 'Question 3' });
    expect(within(article).getByText(/Written response/)).toBeTruthy();
    // Before the PIN step-up: say where the feedback is, show none of it.
    expect(within(article).getByText(/Rubric feedback is shown with the solutions/)).toBeTruthy();
    expect(within(article).queryByText(/Uses complete sentences/)).toBeNull();

    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    const rubric = await within(article).findByRole('region', { name: 'Rubric feedback' });
    const items = within(rubric)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      expect.stringMatching(/✓ Met.*Uses complete sentences.*Both sentences are complete\./),
      expect.stringMatching(/○ Not yet.*Gives a reason.*Add one more reason for the choice\./),
    ]);
    expect(within(article).queryByText(/Rubric feedback is shown with the solutions/)).toBeNull();
    // Writing has no right answer: no empty "Answer" or "Worked solution" lines.
    expect(within(article).queryByText(/^Answer:/)).toBeNull();
    expect(within(article).queryByText(/^Worked solution:/)).toBeNull();
    // Objective items keep their answer and no rubric section.
    const q1 = within(panel).getByRole('article', { name: 'Question 1' });
    expect(within(q1).getByText('7/8')).toBeTruthy();
    expect(within(q1).queryByRole('region', { name: 'Rubric feedback' })).toBeNull();

    await userEvent.click(within(panel).getByRole('button', { name: 'Hide solutions' }));
    expect(within(article).queryByText(/Uses complete sentences/)).toBeNull();
  });

  it('a rubric stored in another JSON shape is still shown as readable text', async () => {
    const { api } = withWriting({ criterion: 'Clear topic sentence', score: 3, strong: true });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    const article = within(panel).getByRole('article', { name: 'Question 3' });
    const rubric = await within(article).findByRole('region', { name: 'Rubric feedback' });
    expect(rubric.textContent).toMatch(/criterion: Clear topic sentence/);
    expect(rubric.textContent).toMatch(/score: 3/);
    expect(rubric.textContent).toMatch(/strong: yes/);
    expect(rubric.textContent).not.toMatch(/\[object Object\]|[{}]/);
  });

  it('after unlocking, a written answer with no stored solution says none was recorded (no PIN prompt)', async () => {
    const { api } = fakeApi({
      get: (path) => {
        if (path === `/v1/assignments/${READY}`) return detail([question(), writingQuestion]);
        if (path.endsWith('/solutions')) return solutions; // no row for the written item
        return undefined;
      },
    });
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    const article = within(panel).getByRole('article', { name: 'Question 3' });
    expect(
      await within(article).findByText(/No rubric feedback was recorded for this answer/),
    ).toBeTruthy();
    expect(within(article).queryByText(/it needs your parent PIN/)).toBeNull();
  });

  it('says so when no rubric feedback was recorded for a written answer', async () => {
    const { api } = withWriting(null);
    renderPage(<HomeworkPage />, { api });
    const panel = await openReadyScan();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show solutions' }));
    const article = within(panel).getByRole('article', { name: 'Question 3' });
    expect(
      await within(article).findByText(/No rubric feedback was recorded for this answer/),
    ).toBeTruthy();
    expect(within(article).queryByRole('region', { name: 'Rubric feedback' })).toBeNull();
  });
});

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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

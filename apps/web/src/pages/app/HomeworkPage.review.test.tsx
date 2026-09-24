import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  AssignmentDetailResponse,
  AssignmentListResponse,
  AssignmentSummary,
  PageAllowance,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import HomeworkPage from './HomeworkPage.tsx';

/**
 * Independent adversarial review of the homework vertical (REVIEW-HOMEWORK), parent web page.
 * `[RV-homework-n]` tests are regression tests for defects found in review and fail on the reviewed
 * code for the stated reason. Synthetic data only (Riley).
 */

const FAMILY = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const READY = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const UPLOADING = '9c4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b';
const Q1 = 'e19e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f2a';
const PAGE = '03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c';
const AT = '2026-09-20T15:00:00.000Z';

function summary(id: string, status: AssignmentSummary['status']): AssignmentSummary {
  return {
    id,
    childId: RILEY,
    subjectId: null,
    status,
    pageCount: 1,
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
  paidSlots: 0,
  billingConflict: null,
  managingChannel: 'app_store',
  children: [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'active' }],
};

function list(
  assignments: AssignmentSummary[],
  allowance: PageAllowance | null,
): AssignmentListResponse {
  return { assignments, allowance };
}

const detail: AssignmentDetailResponse = {
  assignment: summary(READY, 'ready'),
  pages: [{ id: PAGE, pageNumber: 1, mimeType: 'image/jpeg' }],
  questions: [
    {
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
      uncertainty: 'low',
      result: {
        verdict: 'incorrect',
        gradedVerdict: 'incorrect',
        route: 'escalated',
        disagreement: true,
        gradedAt: AT,
        override: null,
      },
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API validating every fixture and response through the real contract schemas. */
function fakeApi(
  get: (path: string) => unknown,
  send: (call: Call) => unknown = () => undefined,
  /** Simulated network latency for GETs (a real reload renders its loading state). */
  latencyMs = 0,
) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const value = path === '/v1/family' ? family : get(path);
        if (value instanceof Error) return Promise.reject(value);
        if (latencyMs > 0) {
          return new Promise<void>((resolve) => setTimeout(resolve, latencyMs)).then(() =>
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
      sends.push({ method, path, body });
      try {
        return Promise.resolve(schema.parse(send({ method, path, body })));
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

describe('HomeworkPage review regressions (REVIEW-HOMEWORK)', () => {
  it('[RV-homework-6] with no paid capacity the page does not claim the child used up this month’s pages or that scanning resumes next month', async () => {
    // Subscription expired: billing sync set paid_slots to 0 (the family ceiling becomes 0), the
    // child's profile is still listed, and Riley has scanned nothing this month.
    const { api } = fakeApi((path) =>
      path.startsWith('/v1/assignments?')
        ? list([], {
            periodKey: 'pages:2026-09',
            childPagesUsed: 0,
            childPagesAllowed: 40,
            familyPagesUsed: 0,
            familyPagesAllowed: 0,
          })
        : new Error(`unexpected GET ${path}`),
    );
    renderPage(<HomeworkPage />, { api });
    const card = await screen.findByRole('region', { name: 'Page allowance' });
    // Reviewed code: "Riley’s page allowance for this month is used up, so new scans will wait until
    // next month." Nothing was used, and nothing changes next month without a subscription.
    expect(within(card).queryByText(/used up/i)).toBeNull();
    expect(within(card).queryByText(/until next month/i)).toBeNull();
  });

  it('[RV-homework-7] the "Uploading" state does not promise the app can reopen a scan to resume it', async () => {
    const { api } = fakeApi((path) =>
      path.startsWith('/v1/assignments?')
        ? list([summary(UPLOADING, 'uploading')], null)
        : new Error(`unexpected GET ${path}`),
    );
    renderPage(<HomeworkPage />, { api });
    const scans = await screen.findByRole('region', { name: 'Scans' });
    // The mobile app keeps an interrupted upload only in the open scan screen's memory: the results
    // screen offers no resume action and opening Scan starts a new, empty scan.
    expect(within(scans).queryByText(/reopen the scan in the app to resume/i)).toBeNull();
  });

  it('[RV-homework-8] the confirmation after saving an override is still shown once the scan has refreshed', async () => {
    const { api, gets, sends } = fakeApi(
      (path) => {
        if (path.startsWith('/v1/assignments?'))
          return list([summary(READY, 'ready')], {
            periodKey: 'pages:2026-09',
            childPagesUsed: 1,
            childPagesAllowed: 40,
            familyPagesUsed: 1,
            familyPagesAllowed: 40,
          });
        if (path === `/v1/assignments/${READY}`) return detail;
        return new Error(`unexpected GET ${path}`);
      },
      () => ({
        questionId: Q1,
        result: {
          verdict: 'correct',
          gradedVerdict: 'incorrect',
          route: 'escalated',
          disagreement: true,
          gradedAt: AT,
          override: { verdict: 'correct', reason: 'Equivalent answer', at: AT },
        },
      }),
      20,
    );
    renderPage(<HomeworkPage />, { api });
    const scans = await screen.findByRole('region', { name: 'Scans' });
    await userEvent.click(within(scans).getByRole('button', { name: /Open scan/ }));
    const panel = await screen.findByRole('region', { name: 'Scan details' });
    const q1 = await within(panel).findByRole('article', { name: 'Question 1' });
    await userEvent.click(within(q1).getByRole('button', { name: 'Change result' }));
    await userEvent.selectOptions(within(q1).getByLabelText('New result'), 'correct');
    await userEvent.type(within(q1).getByLabelText('Reason'), 'Equivalent answer');
    await userEvent.click(within(q1).getByRole('button', { name: 'Save result' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    // Let the refresh the page triggers finish (list and detail reloaded, question shown again).
    await waitFor(() =>
      expect(gets.filter((p) => p === `/v1/assignments/${READY}`).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
    await screen.findByRole('article', { name: 'Question 1' });
    // The save succeeded (no error or PIN prompt), so a confirmation is owed.
    expect(screen.queryByRole('alert')).toBeNull();
    // Reviewed code: the refresh unmounts the question card, so the status message ("Result updated.
    // Points your child already earned are kept.") vanishes before a parent or screen reader gets it.
    expect(screen.queryByText(/Result updated/)).not.toBeNull();
  });

  it('[RV-homework-9] a parent can start a scan (or upload a PDF study guide) for the selected child', async () => {
    const { api } = fakeApi((path) =>
      path.startsWith('/v1/assignments?') ? list([], null) : new Error(`unexpected GET ${path}`),
    );
    renderPage(<HomeworkPage />, { api });
    await screen.findByRole('region', { name: 'Scans' });
    // Spec P5 "Parent selects child ... parent-uploaded PDF study guides", P14 parent "scan uploader".
    // POST /v1/assignments accepts parents, but neither this page nor the parent mobile app
    // (app/(parent)/*) offers any way to add pages: only the child scan screen can upload.
    const uploader =
      screen.queryByRole('button', { name: /scan|upload|add pages|add a pdf/i }) ??
      document.querySelector('input[type="file"]');
    expect(uploader).not.toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  childAssignmentDetailResponseSchema,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { buildResultView, findForbiddenKeys } from './result-view.ts';
import { EMPTY_SESSION, addPages, toScanPage, type ScanPage } from './scan-session.ts';
import { childUploadMessage, newAttempt, toHex, uploadScan, type UploadIo } from './upload.ts';

/**
 * Independent adversarial review of the homework vertical (REVIEW-HOMEWORK), mobile pure logic.
 * `[RV-homework-n]` tests are regression tests for defects found in review and fail on the reviewed
 * code; the remaining tests are passing probes of the riskiest behaviour. Synthetic data only.
 */

const ASSIGNMENT = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const AT = '2026-09-24T15:00:00.000Z';
const limits = DEFAULT_HOMEWORK_UPLOAD_LIMITS;

function state(status: string, pageCount = 2) {
  return {
    assignment: {
      id: ASSIGNMENT,
      subjectId: null,
      status,
      pageCount,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

const io: UploadIo = {
  readBytes: (uri) => Promise.resolve(new TextEncoder().encode(`bytes of ${uri}`)),
  sha256Hex: (bytes) => Promise.resolve(toHex(bytes.slice(0, 32)).padEnd(64, '0')),
  putBytes: () => Promise.resolve(),
};

let n = 0;
const newKey = () => `review-key-${String((n += 1)).padStart(12, '0')}`;

function twoPhotos(): ScanPage[] {
  return [
    toScanPage({ uri: 'file:///p1.jpg', mimeType: 'image/jpeg' }, 'camera', () => 'a'),
    toScanPage({ uri: 'file:///p2.jpg', mimeType: 'image/jpeg' }, 'camera', () => 'b'),
  ];
}

describe('homework review regressions (REVIEW-HOMEWORK, mobile)', () => {
  it('[RV-homework-4] "Try again" after a lost finalize response treats the already-queued scan as sent instead of failing forever', async () => {
    // Server state after attempt 1: finalize committed (scan queued, one reservation, one job) but the
    // response was lost, so the screen kept the same attempt and the child taps "Try again".
    // Responses mirror apps/api/src/routes/homework.ts: create with the same key returns the existing
    // scan (200, status queued); /uploads on a queued scan is 422 INVALID_TRANSITION.
    const calls: string[] = [];
    const send: ApiClient['send'] = (method, path, _body, schema) => {
      calls.push(`${method} ${path}`);
      if (path === '/v1/assignments') return Promise.resolve(schema.parse(state('queued')));
      if (path.endsWith('/uploads')) {
        return Promise.reject(
          new ApiRequestError(
            'BUSINESS_RULE',
            'This scan was already sent.',
            422,
            'INVALID_TRANSITION',
          ),
        );
      }
      if (path.endsWith('/finalize')) return Promise.resolve(schema.parse(state('queued')));
      return Promise.reject(new Error(`unexpected ${path}`));
    };
    const api: ApiClient = { get: () => Promise.reject(new Error('unexpected GET')), send };
    const attempt = { ...newAttempt(newKey), assignmentId: ASSIGNMENT };

    const outcome = await uploadScan({
      api,
      io,
      pages: twoPhotos(),
      limits,
      attempt,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).then(
      (result) => ({ ok: true as const, status: result.assignment.status }),
      (error: unknown) => ({ ok: false as const, message: childUploadMessage(error) }),
    );

    // Reviewed code: uploadScan ignores the status returned by create, posts /uploads, gets 422 and
    // the child sees "Something went wrong. Let's try again." on every retry. Changing a page to
    // escape then cancels the scan that was actually sent and charges a second scan.
    expect(outcome).toEqual({ ok: true, status: 'queued' });
    expect(calls).not.toContain(`POST /v1/assignments/${ASSIGNMENT}/uploads`);
  });
});

describe('homework review probes (mobile)', () => {
  it('results never surface an answer-key field and the fail-closed check catches nested keys', () => {
    const detail = childAssignmentDetailResponseSchema.parse({
      assignment: {
        id: ASSIGNMENT,
        subjectId: null,
        status: 'ready',
        pageCount: 1,
        createdAt: AT,
        updatedAt: AT,
      },
      questions: [
        {
          id: '03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c',
          questionNumber: '1',
          promptText: 'What is 3/4 + 1/8?',
          studentAnswerText: '4/12',
          verdict: 'incorrect',
          feedback: [
            {
              id: '14c13c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              kind: 'hint',
              body: 'Find a common denominator first.',
            },
          ],
        },
      ],
    });
    const view = buildResultView(detail);
    expect(view.questions[0]!.verdict).toMatchObject({ title: 'Try again', icon: '↻' });
    expect(view.questions[0]!.verdict.accessibilityLabel).toBe('Question 1: Try again');
    expect(findForbiddenKeys(view)).toEqual([]);
    expect(findForbiddenKeys({ questions: [{ extra: { worked_solution: 'x' } }] })).toEqual([
      'worked_solution',
    ]);
    // A strict child contract rejects a server that adds a key field.
    expect(() =>
      childAssignmentDetailResponseSchema.parse({
        ...detail,
        questions: [{ ...detail.questions[0], correctAnswer: '7/8' }],
      }),
    ).toThrow();
  });

  it('unresolved work says so without a verdict and pending work shows no verdict', () => {
    const base = {
      assignment: {
        id: ASSIGNMENT,
        subjectId: null,
        status: 'needs_parent_review' as const,
        pageCount: 1,
        createdAt: AT,
        updatedAt: AT,
      },
      questions: [
        {
          id: '03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c',
          questionNumber: '1',
          promptText: 'p',
          studentAnswerText: null,
          verdict: 'needs_parent_review' as const,
          feedback: [],
        },
      ],
    };
    expect(buildResultView(base).questions[0]!.verdict.title).toBe('Ask a grown-up to review this');
    const checking = buildResultView({
      ...base,
      assignment: { ...base.assignment, status: 'checking' },
    });
    expect(checking.questions[0]!.verdict.title).toBe('Still checking');
    expect(checking.summary).toBeNull();
  });

  it('never accepts more pages than the configured limit', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      toScanPage({ uri: `file:///p${i}.jpg`, mimeType: 'image/jpeg' }, 'library', () => `id${i}`),
    );
    const { session, dropped } = addPages(EMPTY_SESSION, many, limits);
    expect(session.pages).toHaveLength(limits.maxPages);
    expect(dropped).toBe(2);
  });
});

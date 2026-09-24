import {
  childPracticeTodayResponseSchema,
  childReviewsResponseSchema,
  practiceAnswerResponseSchema,
  type ChildPracticeToday,
  type ChildReviews,
  type PracticeAnswerRequest,
  type PracticeAnswerResponse,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { childLearningError } from './result-copy.ts';

/**
 * Child practice API calls (spec P6-P9; AC_GRADING_06, AC_REWARDS_01/02). Pure (no react-native)
 * so the behaviour is unit-tested; the screens stay thin. The contracts are strict allowlists, and
 * every loaded payload is additionally scanned for answer-like keys: if one ever appears, the
 * screen fails closed instead of holding it in memory.
 */

export const LEARNING_FORBIDDEN_KEYS = [
  'answer',
  'answers',
  'answerKey',
  'answer_key',
  'answerSpec',
  'answer_spec',
  'correctAnswer',
  'correct_answer',
  'solution',
  'solutions',
  'explanation',
  'accepted',
  'alternates',
  'letters',
  'validLetters',
  'target',
  'expected',
  'spec',
  'rubric',
] as const;

export function findForbiddenLearningKeys(value: unknown): string[] {
  const forbidden = new Set<string>(LEARNING_FORBIDDEN_KEYS);
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, inner] of Object.entries(v)) {
        if (forbidden.has(k)) found.add(k);
        visit(inner);
      }
    }
  };
  visit(value);
  return [...found];
}

function failClosed<T>(value: T): T {
  if (findForbiddenLearningKeys(value).length > 0) {
    throw new ApiRequestError('INTERNAL', 'Unexpected response from the server.', 200);
  }
  return value;
}

export async function loadPracticeToday(api: ApiClient): Promise<ChildPracticeToday> {
  return failClosed(await api.get('/v1/child/practice/today', childPracticeTodayResponseSchema));
}

export async function loadCurrentReview(api: ApiClient): Promise<ChildReviews> {
  return failClosed(await api.get('/v1/child/reviews/current', childReviewsResponseSchema));
}

/**
 * Idempotency keys per question. A retry of the SAME answer after a lost response reuses its key,
 * so a double tap or a flaky connection is graded and rewarded once; a different answer, or a new
 * try after a definite result, gets a fresh key.
 */
export interface AnswerKeys {
  keyFor(itemId: string, answer: string): string;
  settle(itemId: string): void;
}

export function createAnswerKeys(generate: () => string): AnswerKeys {
  const pending = new Map<string, { answer: string; key: string }>();
  return {
    keyFor(itemId, answer) {
      const current = pending.get(itemId);
      if (current && current.answer === answer) return current.key;
      const key = generate();
      pending.set(itemId, { answer, key });
      return key;
    },
    settle(itemId) {
      pending.delete(itemId);
    },
  };
}

export type SubmitOutcome =
  | { readonly ok: true; readonly response: PracticeAnswerResponse }
  | {
      readonly ok: false;
      readonly message: string;
      /** The question or set changed on the server (e.g. removed): reload the practice. */
      readonly reload: boolean;
    };

/** Decision: only a 4xx is a definite "not recorded"; offline or 5xx may have committed. */
function outcomeIsDefinite(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}

/** Sends one (already normalized) answer. The response never contains the correct answer. */
export async function submitPracticeAnswer(
  api: ApiClient,
  keys: AnswerKeys,
  itemId: string,
  answer: string,
): Promise<SubmitOutcome> {
  const body: PracticeAnswerRequest = { answer, idempotencyKey: keys.keyFor(itemId, answer) };
  try {
    const response = await api.send(
      'POST',
      `/v1/child/practice/items/${encodeURIComponent(itemId)}/answer`,
      body,
      practiceAnswerResponseSchema,
    );
    keys.settle(itemId);
    return { ok: true, response };
  } catch (error) {
    if (outcomeIsDefinite(error)) keys.settle(itemId);
    return {
      ok: false,
      message: childLearningError(error),
      reload: error instanceof ApiRequestError && error.code === 'NOT_FOUND',
    };
  }
}

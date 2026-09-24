/**
 * Child results copy (spec P6 display rules; AC_GRADING_06, AC_UX_02). For objectively gradable work
 * the child sees "Correct" or "Try again" with an icon and accessible text; unresolved input says
 * "Let's get a clearer picture" or "Ask a grown-up to review this". The child sees their own answer
 * and guarded hints — the response contract has no field that could carry an answer key.
 *
 * Safety (spec P4; AC_SECURITY_02): when the scan job's safety screen flagged an answer, the question
 * carries a reviewed 'safety' template instead of coaching. It is shown as its own calm notice
 * ("Let’s talk with a grown-up"), never as a hint and never next to a "Try again"; the text is the
 * reviewed template from the server (it names a trusted grown-up and help lines and never claims
 * that anyone was alerted). When any answer was flagged, the page's status header and body (which
 * the results screen already renders) become the notice, every distinct template once, and the
 * score line is hidden: the child sees the help lines even where no per-question card is shown.
 *
 * Pure logic with no react-native imports so it is unit-testable.
 */
import {
  CHILD_FORBIDDEN_HOMEWORK_KEYS,
  type AssignmentStatus,
  type ChildAssignmentDetailResponse,
  type GradedVerdict,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';

export type VerdictTone = 'success' | 'retry' | 'help' | 'info' | 'pending';

export interface VerdictView {
  readonly title: string;
  /** Text glyph shown next to the title so meaning never depends on colour alone. */
  readonly icon: string;
  readonly tone: VerdictTone;
  readonly accessibilityLabel: string;
}

const VERDICTS: Record<
  GradedVerdict | 'pending',
  { title: string; icon: string; tone: VerdictTone }
> = {
  correct: { title: 'Correct', icon: '✓', tone: 'success' },
  incorrect: { title: 'Try again', icon: '↻', tone: 'retry' },
  // A blank answer is an invitation to try, not a judgment.
  unanswered: { title: 'Try again', icon: '✎', tone: 'retry' },
  unresolved: { title: 'Let’s get a clearer picture', icon: '◎', tone: 'help' },
  needs_parent_review: { title: 'Ask a grown-up to review this', icon: '⚑', tone: 'help' },
  // Writing is reviewed with a rubric, never forced into right/wrong (spec P5).
  rubric: { title: 'Feedback is ready', icon: '★', tone: 'info' },
  pending: { title: 'Still checking', icon: '…', tone: 'pending' },
};

/**
 * Written work with no guarded feedback sent to the child. The rubric itself is parent-only (never in
 * a child DTO), so the child is not promised feedback it can't see (AC_GRADING_03); the parent sees
 * the rubric feedback with the solutions.
 */
const RUBRIC_WITHOUT_FEEDBACK = {
  title: 'Ask a grown-up to go over your writing',
  icon: '★',
  tone: 'help',
} as const satisfies Omit<VerdictView, 'accessibilityLabel'>;

/**
 * `hasFeedback` says whether guarded feedback was sent for this question; it only changes the copy
 * for written work, which says "Feedback is ready" only when there is feedback to read.
 */
export function verdictView(
  verdict: GradedVerdict | null,
  questionNumber: string,
  hasFeedback = true,
): VerdictView {
  const v =
    verdict === 'rubric' && !hasFeedback ? RUBRIC_WITHOUT_FEEDBACK : VERDICTS[verdict ?? 'pending'];
  return { ...v, accessibilityLabel: `Question ${questionNumber}: ${v.title}` };
}

/** Calm title for a question whose answer the safety screen flagged. */
export const SAFETY_NOTICE_TITLE = 'Let’s talk with a grown-up';

const SAFETY_VERDICT = {
  title: SAFETY_NOTICE_TITLE,
  icon: '♡',
  tone: 'help',
} as const satisfies Omit<VerdictView, 'accessibilityLabel'>;

/** The reviewed safety template, rendered as a distinct notice (not a hint). */
export interface SafetyNoticeView {
  readonly title: string;
  readonly body: string;
  /** The template row, so the help screen can attach it to a report. */
  readonly feedbackId: string;
  readonly accessibilityLabel: string;
}

export interface StatusView {
  readonly title: string;
  readonly body: string;
  readonly showResults: boolean;
  /** Whether "check again" makes sense (work still in progress). */
  readonly inProgress: boolean;
}

export function statusView(status: AssignmentStatus): StatusView {
  switch (status) {
    case 'draft':
    case 'uploading':
      return {
        title: 'Not sent yet',
        body: 'This scan hasn’t finished sending. Open Scan to send it again.',
        showResults: false,
        inProgress: false,
      };
    case 'queued':
    case 'extracting':
    case 'checking':
    case 'verifying':
      return {
        title: 'We’re checking your work',
        body: 'Come back soon to see how you did.',
        showResults: false,
        inProgress: true,
      };
    case 'failed_retryable':
      return {
        title: 'Still working on it',
        body: 'This is taking a little longer. Come back soon.',
        showResults: false,
        inProgress: true,
      };
    case 'ready':
      return { title: 'Your results are ready', body: '', showResults: true, inProgress: false };
    case 'needs_rescan':
      return {
        title: 'Let’s get a clearer picture',
        body: 'Some pages were hard to read. Try scanning them again in good light, flat on a table.',
        showResults: false,
        inProgress: false,
      };
    case 'needs_parent_review':
      return {
        title: 'Ask a grown-up to review this',
        body: 'A grown-up will take a look at some answers.',
        showResults: true,
        inProgress: false,
      };
    case 'failed_final':
      return {
        title: 'Let’s try a new scan',
        body: 'We couldn’t read this one. Ask a grown-up for help, or scan it again.',
        showResults: false,
        inProgress: false,
      };
    case 'cancelled':
      return {
        title: 'Stopped',
        body: 'This scan was stopped.',
        showResults: false,
        inProgress: false,
      };
    case 'deleted':
      return {
        title: 'Removed',
        body: 'This scan was removed.',
        showResults: false,
        inProgress: false,
      };
  }
}

export interface QuestionView {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly yourAnswer: string;
  readonly verdict: VerdictView;
  readonly hints: readonly string[];
  /** Present when the answer was flagged: show this notice instead of hints and the verdict. */
  readonly safety: SafetyNoticeView | null;
}

export interface ResultView {
  readonly status: StatusView;
  readonly questions: readonly QuestionView[];
  /** Counts only; null until results can be shown. */
  readonly summary: string | null;
}

export function buildResultView(detail: ChildAssignmentDetailResponse): ResultView {
  const status = statusView(detail.assignment.status);
  const questions = detail.questions.map((q): QuestionView => {
    const verdict = status.showResults ? q.verdict : null;
    const flagged = status.showResults
      ? [...q.feedback].reverse().find((f) => f.kind === 'safety')
      : undefined;
    // A flagged answer shows only the calm notice: no coaching (even from an earlier
    // transcription) and no "Try again" next to it. The stored grade is unchanged.
    const hints =
      status.showResults && flagged === undefined
        ? q.feedback.filter((f) => f.kind !== 'safety').map((f) => f.body)
        : [];
    const safety: SafetyNoticeView | null =
      flagged === undefined
        ? null
        : {
            title: SAFETY_NOTICE_TITLE,
            body: flagged.body,
            feedbackId: flagged.id,
            accessibilityLabel: `Question ${q.questionNumber}: ${SAFETY_NOTICE_TITLE}. ${flagged.body}`,
          };
    return {
      id: q.id,
      label: `Question ${q.questionNumber}`,
      prompt: q.promptText,
      yourAnswer:
        q.studentAnswerText && q.studentAnswerText.trim().length > 0
          ? q.studentAnswerText
          : 'You left this one blank',
      verdict:
        safety === null
          ? verdictView(verdict, q.questionNumber, hints.length > 0)
          : {
              ...SAFETY_VERDICT,
              accessibilityLabel: `Question ${q.questionNumber}: ${SAFETY_NOTICE_TITLE}`,
            },
      hints,
      safety,
    };
  });
  const notices = [
    ...new Set(questions.flatMap((q) => (q.safety === null ? [] : [q.safety.body]))),
  ];
  if (notices.length > 0) {
    return {
      status: { ...status, title: SAFETY_NOTICE_TITLE, body: notices.join('\n\n') },
      questions,
      summary: null,
    };
  }
  let summary: string | null = null;
  if (status.showResults && questions.length > 0) {
    const count = (tones: VerdictTone[]) =>
      questions.filter((q) => tones.includes(q.verdict.tone)).length;
    const parts = [
      [count(['success']), 'correct'],
      [count(['retry']), 'to try again'],
      [count(['help']), 'to check'],
      [count(['info']), 'with feedback'],
    ] as const;
    summary = parts
      .filter(([n]) => n > 0)
      .map(([n, label]) => `${n} ${label}`)
      .join(' · ');
  }
  return { status, questions, summary };
}

/**
 * Defense in depth for AC_GRADING_06: lists any answer-key/solution/confidence field found anywhere in
 * a value. The strict response contract already rejects such payloads; screens also assert this.
 */
export function findForbiddenKeys(value: unknown): string[] {
  const forbidden = new Set<string>(CHILD_FORBIDDEN_HOMEWORK_KEYS);
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

/** Calm copy when results cannot be loaded (offline, unpaired, missing); never raw server text. */
export function childLoadMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'NETWORK') return 'You seem to be offline. Try again when you’re connected.';
    if (error.code === 'UNAUTHENTICATED') return 'Ask a grown-up to connect this device again.';
    if (error.code === 'NOT_FOUND') return 'We couldn’t find that scan.';
    if (error.code === 'RATE_LIMITED') return 'Let’s take a little break and try again soon.';
  }
  return 'Something went wrong. Let’s try again.';
}

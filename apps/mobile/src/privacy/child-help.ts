/**
 * Child help / report screen logic (spec P4 "child-safe help/report button", P14 "report/help";
 * AC_SECURITY_01). Pure: no react-native imports, so it is unit-tested.
 *
 * Copy rules: calm and encouraging; never an answer, score or commercial content; never a promise
 * that a parent was alerted (nothing delivers such an alert today — spec P4).
 */
import {
  childReportResponseSchema,
  uuidSchema,
  type ChildReportCategory,
  type ChildReportRequest,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';

export interface ChildReportChoice {
  readonly category: ChildReportCategory;
  readonly label: string;
  readonly hint: string;
}

export const CHILD_REPORT_CHOICES: readonly ChildReportChoice[] = [
  {
    category: 'upsetting',
    label: 'Something upsetting',
    hint: 'Something made me feel worried, sad or uncomfortable.',
  },
  {
    category: 'wrong_or_confusing',
    label: 'This seems wrong',
    hint: 'A check or hint doesn’t look right to me.',
  },
  {
    category: 'answer_revealed',
    label: 'It showed an answer',
    hint: 'It gave me the answer instead of helping me think.',
  },
  { category: 'other', label: 'Something else', hint: 'Something else doesn’t feel okay.' },
];

export const CHILD_HELP_COPY = {
  title: 'Need some help?',
  intro: 'You did a good thing by coming here. It’s always okay to ask for help.',
  tellGrownUpTitle: 'Tell a grown-up',
  tellGrownUp:
    'Find a grown-up you trust, like someone at home or your teacher, and show them this screen.',
  urgent: 'If you ever feel unsafe, go to a grown-up near you right away.',
  reportTitle: 'Tell PencilLift',
  reportIntro: 'Pick the one that fits best. You don’t have to write anything.',
  notConnected:
    'This device isn’t connected right now, so we can’t save a report. Please tell a grown-up.',
  sending: 'Sending…',
} as const;

/** Shown after a report is saved. Reviewed local copy — the server's text is never displayed. */
export const CHILD_REPORT_SENT =
  'Thank you for telling us. We saved your report so it can be checked. You can also tell a grown-up you trust.';

export interface ReportContext {
  readonly questionId?: string;
  readonly feedbackId?: string;
}

/**
 * Route params → report context. Only a single, well-formed uuid is kept for each field; the server
 * still checks that the question or hint belongs to this child.
 */
export function parseReportContext(
  params: Readonly<Record<string, string | string[] | undefined>>,
): ReportContext {
  const pick = (value: string | string[] | undefined): string | undefined =>
    typeof value === 'string' && uuidSchema.safeParse(value).success ? value : undefined;
  const questionId = pick(params.questionId);
  const feedbackId = pick(params.feedbackId);
  return {
    ...(questionId ? { questionId } : {}),
    ...(feedbackId ? { feedbackId } : {}),
  };
}

export type ChildReportOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string; readonly dropContext: boolean };

/** Calm copy per failure; anything not listed gets the generic "tell a grown-up" message. */
const CHILD_REPORT_ERRORS: Readonly<Record<string, string>> = {
  NETWORK: 'We couldn’t send this right now. Please tell a grown-up, and you can try again later.',
  UNAUTHENTICATED: CHILD_HELP_COPY.notConnected,
  RATE_LIMITED: 'Thanks for all your reports. Let’s take a little break. Please tell a grown-up.',
  NOT_FOUND: 'We couldn’t add that page to your report. You can still send it, or tell a grown-up.',
};

export function childReportErrorMessage(error: unknown): string {
  const code = error instanceof ApiRequestError ? error.code : 'INTERNAL';
  return CHILD_REPORT_ERRORS[code] ?? 'Something went wrong sending this. Please tell a grown-up.';
}

export async function sendChildReport(
  api: ApiClient,
  category: ChildReportCategory,
  context: ReportContext,
): Promise<ChildReportOutcome> {
  const body: ChildReportRequest = {
    category,
    ...(context.questionId ? { questionId: context.questionId } : {}),
    ...(context.feedbackId ? { feedbackId: context.feedbackId } : {}),
  };
  try {
    await api.send('POST', '/v1/child/reports', body, childReportResponseSchema);
    return { ok: true, message: CHILD_REPORT_SENT };
  } catch (error) {
    return {
      ok: false,
      message: childReportErrorMessage(error),
      // The linked question/hint was refused; the child can still send the report without it.
      dropContext: error instanceof ApiRequestError && error.code === 'NOT_FOUND',
    };
  }
}

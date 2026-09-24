import { describe, expect, it } from 'vitest';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  CHILD_HELP_COPY,
  CHILD_REPORT_CHOICES,
  CHILD_REPORT_SENT,
  childReportErrorMessage,
  parseReportContext,
  sendChildReport,
} from './child-help.ts';

// Synthetic ids only.
const QUESTION = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const FEEDBACK = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(reply: (call: Sent) => unknown): { api: ApiClient; sent: Sent[] } {
  const sent: Sent[] = [];
  // Responses pass through the real contract schema, exactly as the production client does.
  const handle = (call: Sent, schema: { parse: (v: unknown) => unknown }): Promise<never> => {
    sent.push(call);
    const value = reply(call);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(schema.parse(value) as never);
  };
  const api: ApiClient = {
    get: () => Promise.reject(new Error('unexpected GET')),
    send: (method, path, body, schema) => handle({ method, path, body }, schema),
  };
  return { api, sent };
}

const ALL_CHILD_COPY = [
  ...Object.values(CHILD_HELP_COPY),
  CHILD_REPORT_SENT,
  ...CHILD_REPORT_CHOICES.flatMap((c) => [c.label, c.hint]),
  ...(['NETWORK', 'UNAUTHENTICATED', 'RATE_LIMITED', 'NOT_FOUND', 'INTERNAL'] as const).map(
    (code) => childReportErrorMessage(new ApiRequestError(code, 'server text', 0)),
  ),
];

describe('child help and report choices (spec P4, AC_SECURITY_01)', () => {
  it('offers exactly the four calm report choices, mapped to report categories', () => {
    expect(CHILD_REPORT_CHOICES.map((c) => [c.label, c.category])).toEqual([
      ['Something upsetting', 'upsetting'],
      ['This seems wrong', 'wrong_or_confusing'],
      ['It showed an answer', 'answer_revealed'],
      ['Something else', 'other'],
    ]);
  });

  it('always offers "Tell a grown-up", which works without a connection', () => {
    expect(CHILD_HELP_COPY.tellGrownUpTitle).toBe('Tell a grown-up');
    expect(CHILD_HELP_COPY.tellGrownUp).toMatch(/grown-up you trust/i);
  });

  it('never promises that a parent was alerted, and never shows answers, scores or commerce', () => {
    for (const text of ALL_CHILD_COPY) {
      expect(text).not.toMatch(/\b(parent|mom|dad)s?\b.*\b(told|alerted|notified|know)\b/i);
      expect(text).not.toMatch(/alert|notif|we told|has been told|will see this/i);
      expect(text).not.toMatch(/answer key|solution|confidence|score|buy|price|\$/i);
    }
  });

  it('sends only the category and the child’s own valid context ids', async () => {
    const { api, sent } = fakeApi(() => ({ received: true, message: 'server copy' }));
    const result = await sendChildReport(api, 'answer_revealed', {
      questionId: QUESTION,
      feedbackId: FEEDBACK,
    });
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/v1/child/reports',
        body: { category: 'answer_revealed', questionId: QUESTION, feedbackId: FEEDBACK },
      },
    ]);
    // The child sees reviewed local copy, not whatever text the server sent.
    expect(result).toEqual({ ok: true, message: CHILD_REPORT_SENT });

    await sendChildReport(api, 'other', {});
    expect(sent[1]!.body).toEqual({ category: 'other' });
  });

  it('parses route params into context, dropping anything that is not a single uuid', () => {
    expect(parseReportContext({ questionId: QUESTION, feedbackId: FEEDBACK })).toEqual({
      questionId: QUESTION,
      feedbackId: FEEDBACK,
    });
    expect(
      parseReportContext({ questionId: 'not-a-uuid', feedbackId: [FEEDBACK, FEEDBACK] }),
    ).toEqual({});
    expect(parseReportContext({ childId: QUESTION, familyId: QUESTION })).toEqual({});
  });

  it('turns failures into calm messages that point to a grown-up', async () => {
    const offline = fakeApi(() => new ApiRequestError('NETWORK', 'offline', 0));
    const result = await sendChildReport(offline.api, 'upsetting', {});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tell a grown-up/i);

    const missing = fakeApi(() => new ApiRequestError('NOT_FOUND', 'nope', 404));
    const notFound = await sendChildReport(missing.api, 'wrong_or_confusing', {
      questionId: QUESTION,
    });
    expect(notFound).toMatchObject({ ok: false, dropContext: true });

    const unexpected = fakeApi(() => new Error('boom'));
    const failed = await sendChildReport(unexpected.api, 'other', {});
    expect(failed).toMatchObject({ ok: false, dropContext: false });
    expect(failed.message).toMatch(/grown-up/i);
  });
});

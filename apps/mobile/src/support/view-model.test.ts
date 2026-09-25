import { describe, expect, it } from 'vitest';
import {
  SUPPORT_CASE_KIND_LABELS,
  SUPPORT_CASE_STATUS_LABELS,
  SUPPORT_INTAKE_NOTICE,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_RULES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  createSupportCaseRequestSchema,
  replySupportCaseRequestSchema,
  supportCaseKindSchema,
  supportCaseStatusSchema,
  type SupportBillingPeriod,
  type SupportCase,
  type SupportCaseDetail,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  ageLabel,
  billingPeriodOptions,
  caseRow,
  caseRows,
  channelName,
  charactersLeft,
  EMPTY_DRAFT,
  KIND_HINTS,
  latestReplyLine,
  NO_PERIOD_VALUE,
  outcomeLine,
  periodChipLabel,
  periodLabel,
  refundLine,
  repliesLine,
  replySentMessage,
  STATUS_NOTES,
  SUPPORT_KIND_OPTIONS,
  supportProblem,
  threadEntries,
  validateDraft,
  validateReply,
} from './view-model.ts';

// Synthetic data only: no child names, no homework text. Subjects are about the account and plan.
const NOW = new Date('2026-09-25T12:00:00.000Z');
const UTC = 'UTC';
const CASE_ID = '11111111-1111-4111-8111-111111111111';
const PERIOD_ID = '22222222-2222-4222-8222-222222222222';

const PERIOD: SupportBillingPeriod = {
  id: PERIOD_ID,
  channel: 'app_store',
  providerPeriodId: 'txn_synthetic_001',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  paidSlots: 1,
  chargedCents: 3999,
  refundedCents: 0,
  settlement: 'settled',
};

function aCase(overrides: Partial<SupportCase> = {}): SupportCase {
  return {
    id: CASE_ID,
    kind: 'billing_issue',
    status: 'open',
    subject: 'Charged twice in September',
    body: 'My September statement shows two charges for the one-child plan.',
    billingPeriod: null,
    resolution: null,
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
    resolvedAt: null,
    canReply: true,
    messageCount: 0,
    ...overrides,
  };
}

function aDetail(overrides: Partial<SupportCaseDetail> = {}): SupportCaseDetail {
  return { ...aCase(), messages: [], ...overrides };
}

describe('kinds and statuses', () => {
  it('offers every contract kind, in contract order, with the shared label', () => {
    expect(SUPPORT_KIND_OPTIONS.map((o) => o.value)).toEqual(supportCaseKindSchema.options);
    for (const option of SUPPORT_KIND_OPTIONS) {
      expect(option.label).toBe(SUPPORT_CASE_KIND_LABELS[option.value]);
      expect(KIND_HINTS[option.value].length).toBeGreaterThan(20);
    }
  });

  it('explains every status in text, never leaving one to colour', () => {
    for (const status of supportCaseStatusSchema.options) {
      expect(STATUS_NOTES[status].length).toBeGreaterThan(20);
    }
    expect(STATUS_NOTES.closed).toMatch(/open a new case/);
    expect(STATUS_NOTES.resolved).toMatch(/reopens/);
  });

  it('shares the intake notice with the web portal and it names what to leave out', () => {
    expect(SUPPORT_INTAKE_NOTICE).toMatch(/child’s name, homework text or answers/);
  });
});

describe('ageLabel', () => {
  it.each([
    ['2026-09-25T12:00:00.000Z', 'just now'],
    ['2026-09-25T11:59:01.000Z', 'just now'],
    ['2026-09-25T11:59:00.000Z', '1 minute ago'],
    ['2026-09-25T11:55:00.000Z', '5 minutes ago'],
    ['2026-09-25T11:00:00.000Z', '1 hour ago'],
    ['2026-09-24T12:00:01.000Z', '23 hours ago'],
    ['2026-09-24T12:00:00.000Z', '1 day ago'],
    ['2026-09-19T12:00:00.000Z', '6 days ago'],
    ['2026-09-18T12:00:00.000Z', 'on Sep 18, 2026'],
    ['2026-06-01T12:00:00.000Z', 'on Jun 1, 2026'],
  ])('%s -> %s', (iso, expected) => {
    expect(ageLabel(iso, NOW, UTC)).toBe(expected);
  });

  it('never shows a negative age for a future instant or an unparseable one', () => {
    expect(ageLabel('2026-09-25T12:05:00.000Z', NOW, UTC)).toBe('just now');
    expect(ageLabel('not a date', NOW, UTC)).toBe('just now');
  });
});

describe('billing periods', () => {
  it('names the store and the period with the charge in dollars and cents', () => {
    expect(periodLabel(PERIOD, UTC)).toBe(
      'App Store · Sep 1, 2026 to Oct 1, 2026 · $39.99 for 1 child',
    );
    expect(periodChipLabel(PERIOD, UTC)).toBe('App Store · Sep 1, 2026 · $39.99');
    expect(
      periodLabel({ ...PERIOD, channel: 'play_store', paidSlots: 3, chargedCents: 5997 }, UTC),
    ).toBe('Google Play · Sep 1, 2026 to Oct 1, 2026 · $59.97 for 3 children');
  });

  it('names every channel the contract knows and falls back to the raw key for an unknown one', () => {
    expect(channelName('amazon_appstore')).toBe('Amazon Appstore');
    expect(channelName('stripe')).toBe('Web billing');
    expect(channelName('future_store' as SupportBillingPeriod['channel'])).toBe('future_store');
  });

  it('repeats only what the store reported about a refund', () => {
    expect(refundLine(PERIOD)).toBe(
      'No refund reported by the store yet. This case updates when the store reports one.',
    );
    expect(refundLine({ ...PERIOD, settlement: 'pending' })).toBe(
      'No refund reported by the store yet; this charge is not settled by the store yet.',
    );
    expect(refundLine({ ...PERIOD, settlement: 'refunded', refundedCents: 3999 })).toBe(
      'The store has reported $39.99 refunded on this period (refunded by the store).',
    );
    expect(refundLine({ ...PERIOD, settlement: 'partially_refunded', refundedCents: 1000 })).toBe(
      'The store has reported $10.00 refunded on this period (partly refunded by the store).',
    );
    expect(refundLine({ ...PERIOD, settlement: 'chargeback', refundedCents: 3999 })).toMatch(
      /charged back through the store/,
    );
  });

  it('offers "not sure" first, then the periods as the API ordered them', () => {
    const older = {
      ...PERIOD,
      id: '33333333-3333-4333-8333-333333333333',
      periodStart: '2026-08-01T00:00:00.000Z',
    };
    const options = billingPeriodOptions([PERIOD, older], UTC);
    expect(options[0]).toEqual({ value: NO_PERIOD_VALUE, label: 'Not sure which period' });
    expect(options.map((o) => o.value)).toEqual([NO_PERIOD_VALUE, PERIOD.id, older.id]);
    expect(options[2]!.label).toBe('App Store · Aug 1, 2026 · $39.99');
  });
});

describe('the list', () => {
  it('spells out kind, status, age, replies and outcome for a row', () => {
    const row = caseRow(
      aCase({ status: 'resolved', resolution: 'answered', messageCount: 2, canReply: true }),
      NOW,
      UTC,
    );
    expect(row).toMatchObject({
      id: CASE_ID,
      subject: 'Charged twice in September',
      kindLabel: 'Billing issue',
      statusLabel: SUPPORT_CASE_STATUS_LABELS.resolved,
      statusNote: STATUS_NOTES.resolved,
      openedLine: 'Opened 2 days ago',
      repliesLine: '2 replies',
      outcomeLine: 'Outcome: Answered',
      needsYou: false,
      canReply: true,
    });
    expect(row.accessibilityLabel).toBe(
      'Charged twice in September. Billing issue. Resolved. Opened 2 days ago. 2 replies. Outcome: Answered',
    );
  });

  it('marks a case waiting on the parent in text and lists it first', () => {
    const waiting = aCase({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'waiting_on_parent',
      createdAt: '2026-09-10T12:00:00.000Z',
    });
    const closed = aCase({
      id: '55555555-5555-4555-8555-555555555555',
      status: 'closed',
      canReply: false,
      resolution: 'no_refund',
    });
    const rows = caseRows([aCase(), closed, waiting], NOW, UTC);
    expect(rows.map((r) => r.id)).toEqual([waiting.id, CASE_ID, closed.id]);
    expect(rows[0]).toMatchObject({
      needsYou: true,
      statusLabel: 'Waiting on you',
      openedLine: 'Opened on Sep 10, 2026',
    });
    expect(rows[0]!.accessibilityLabel).toMatch(/Needs your reply/);
    expect(rows[2]).toMatchObject({ canReply: false, outcomeLine: 'Outcome: No refund' });
  });

  it('counts replies without the opening message', () => {
    expect(repliesLine(0)).toBe('No replies yet');
    expect(repliesLine(1)).toBe('1 reply');
    expect(repliesLine(3)).toBe('3 replies');
    expect(outcomeLine({ resolution: null })).toBeNull();
    expect(outcomeLine({ resolution: 'refunded_by_store' })).toBe('Outcome: Refunded by the store');
  });
});

describe('the thread', () => {
  const detail = aDetail({
    messages: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        authorKind: 'parent',
        body: 'The second charge shows a different order number.',
        createdAt: '2026-09-24T09:00:00.000Z',
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        authorKind: 'admin',
        body: 'Thanks. We see the two charges on the store’s report and are looking into it.',
        createdAt: '2026-09-23T15:00:00.000Z',
      },
    ],
  });

  it('starts with the opening message, orders replies oldest first and marks the newest reply', () => {
    const entries = threadEntries(detail, NOW, UTC);
    expect(entries.map((e) => [e.author, e.when, e.isLatestReply])).toEqual([
      ['You', '2 days ago', false],
      ['PencilLift support', '1 day ago', false],
      ['You', '1 day ago', true],
    ]);
    expect(entries[0]!.body).toBe(detail.body);
    expect(latestReplyLine(detail, NOW, UTC)).toBe('Latest reply from you, 1 day ago');
  });

  it('names the team as the latest author and has no latest line before any reply', () => {
    const staffLast = aDetail({ messages: [detail.messages[1]!] });
    expect(latestReplyLine(staffLast, NOW, UTC)).toBe(
      'Latest reply from PencilLift support, 1 day ago',
    );
    expect(latestReplyLine(aDetail(), NOW, UTC)).toBeNull();
    expect(threadEntries(aDetail(), NOW, UTC)).toHaveLength(1);
  });

  it('says when a reply put the case back with the team', () => {
    expect(replySentMessage('resolved', 'open')).toMatch(
      /open again and back with the PencilLift team/,
    );
    expect(replySentMessage('waiting_on_parent', 'open')).toMatch(/open again/);
    expect(replySentMessage('open', 'open')).toBe('Reply sent. We’ll answer here.');
    expect(replySentMessage('in_progress', 'in_progress')).toBe('Reply sent. We’ll answer here.');
  });
});

describe('validateDraft', () => {
  it('trims and builds a body the contract accepts', () => {
    const result = validateDraft({
      ...EMPTY_DRAFT,
      kind: 'bug',
      subject: '  Practice page will not open  ',
      message: '  Tapping Start practice shows a blank screen on my tablet.  ',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        kind: 'bug',
        subject: 'Practice page will not open',
        message: 'Tapping Start practice shows a blank screen on my tablet.',
      },
    });
    expect(result.ok && createSupportCaseRequestSchema.safeParse(result.body).success).toBe(true);
  });

  it('reports an empty subject and message in one pass', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, subject: '   ', message: '\n' })).toEqual({
      ok: false,
      problems: { subject: 'Add a short subject.', message: 'Tell us what happened.' },
    });
  });

  it('caps the subject at 120 and the message at 2,000 characters, counting after trimming', () => {
    const long = validateDraft({
      ...EMPTY_DRAFT,
      subject: 'x'.repeat(SUPPORT_SUBJECT_MAX_LENGTH + 1),
      message: 'y'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 5),
    });
    expect(long).toEqual({
      ok: false,
      problems: {
        subject: 'Keep the subject to 120 characters (yours is 121).',
        message: 'Keep your message to 2,000 characters (yours is 2,005).',
      },
    });
    const exact = validateDraft({
      ...EMPTY_DRAFT,
      subject: ` ${'x'.repeat(SUPPORT_SUBJECT_MAX_LENGTH)} `,
      message: 'y'.repeat(SUPPORT_MESSAGE_MAX_LENGTH),
    });
    expect(exact.ok).toBe(true);
  });

  it('sends a billing period with a refund request only, and passes the contract refine', () => {
    const refund = validateDraft({
      kind: 'refund_request',
      subject: 'Refund for September',
      message: 'We cancelled before the renewal but were still charged.',
      billingPeriodId: PERIOD_ID,
    });
    expect(refund.ok && refund.body.billingPeriodId).toBe(PERIOD_ID);
    expect(refund.ok && createSupportCaseRequestSchema.safeParse(refund.body).success).toBe(true);

    // A period picked before the kind was switched is dropped, not sent to be rejected.
    const switched = validateDraft({
      kind: 'billing_issue',
      subject: 'Refund for September',
      message: 'We cancelled before the renewal but were still charged.',
      billingPeriodId: PERIOD_ID,
    });
    expect(switched.ok && 'billingPeriodId' in switched.body).toBe(false);
    expect(switched.ok && createSupportCaseRequestSchema.safeParse(switched.body).success).toBe(
      true,
    );

    const none = validateDraft({
      kind: 'refund_request',
      subject: 'Refund for September',
      message: 'We cancelled before the renewal but were still charged.',
      billingPeriodId: NO_PERIOD_VALUE,
    });
    expect(none.ok && 'billingPeriodId' in none.body).toBe(false);
  });
});

describe('validateReply and counters', () => {
  it('trims, refuses an empty reply and caps at 2,000 characters', () => {
    expect(validateReply('  Still not showing.  ')).toEqual({
      ok: true,
      body: { message: 'Still not showing.' },
    });
    expect(validateReply('   ')).toEqual({ ok: false, problem: 'Write your reply first.' });
    expect(validateReply('z'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      problem: 'Keep your reply to 2,000 characters (yours is 2,001).',
    });
    const ok = validateReply('z'.repeat(SUPPORT_MESSAGE_MAX_LENGTH));
    expect(ok.ok && replySupportCaseRequestSchema.safeParse(ok.body).success).toBe(true);
  });

  it('counts characters left with a thousands separator and never below zero', () => {
    expect(charactersLeft('', SUPPORT_MESSAGE_MAX_LENGTH)).toBe('2,000 characters left');
    expect(charactersLeft('a'.repeat(1999), SUPPORT_MESSAGE_MAX_LENGTH)).toBe('1 character left');
    expect(charactersLeft('a'.repeat(2500), SUPPORT_MESSAGE_MAX_LENGTH)).toBe('0 characters left');
  });
});

describe('supportProblem', () => {
  const rule = (code: string) => new ApiRequestError('BUSINESS_RULE', 'server text', 422, code);

  it('explains a closed case and a period that is not the family’s', () => {
    expect(supportProblem(rule(SUPPORT_RULES.caseClosed), 'reply').message).toMatch(
      /closed, so it takes no more replies/,
    );
    expect(supportProblem(rule(SUPPORT_RULES.billingPeriodNotFound), 'open').message).toMatch(
      /isn’t one of your family’s/,
    );
    expect(supportProblem(rule('SOME_NEW_RULE'), 'open').message).toBe('server text');
  });

  it('keys rate limits and not-found on what the parent was doing', () => {
    const limited = new ApiRequestError('RATE_LIMITED', 'Too many requests', 429);
    expect(supportProblem(limited, 'open').message).toMatch(
      /opened several cases in the last hour/,
    );
    expect(supportProblem(limited, 'reply').message).toMatch(/quite a few messages/);
    const missing = new ApiRequestError('NOT_FOUND', 'Case not found', 404);
    expect(supportProblem(missing, 'load')).toEqual({
      message: 'Create your family in the parent portal first.',
      needsPin: false,
      noFamily: true,
    });
    expect(supportProblem(missing, 'case').message).toMatch(/isn’t available anymore/);
  });

  it('asks for the PIN on step-up and never shows raw text for unknown failures', () => {
    expect(supportProblem(new ApiRequestError('STEP_UP_REQUIRED', 'x', 403), 'open')).toEqual({
      message: 'Enter your parent PIN to continue, then try again.',
      needsPin: true,
      noFamily: false,
    });
    expect(supportProblem(new ApiRequestError('NETWORK', 'offline', 0), 'load').message).toMatch(
      /offline/,
    );
    expect(
      supportProblem(new ApiRequestError('UNAUTHENTICATED', 'x', 401), 'load').message,
    ).toMatch(/sign in again/);
    expect(
      supportProblem(new ApiRequestError('CHILD_MODE_FORBIDDEN', 'x', 403), 'open').message,
    ).toMatch(/grown-up/);
    expect(
      supportProblem(new ApiRequestError('VALIDATION_FAILED', 'x', 400), 'open').message,
    ).toMatch(/check the subject and message/);
    expect(
      supportProblem(new ApiRequestError('INTERNAL', 'stack trace here', 500), 'open').message,
    ).toBe('Something went wrong. Please try again.');
    expect(supportProblem(new Error('boom'), 'reply').message).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

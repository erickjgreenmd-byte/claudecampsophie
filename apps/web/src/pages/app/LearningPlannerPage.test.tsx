import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  AnswerKeyResponse,
  ChildSubject,
  LearningScheduleResponse,
  PracticeSets,
  SkillsResponse,
  TestDate,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { unconfiguredAuth } from '../../lib/auth.ts';
import { renderPage } from '../../test/render.tsx';
import LearningPlannerPage from './LearningPlannerPage.tsx';

// Synthetic data only (Riley, Sam). Every fixture and response goes through the real contract
// schemas in the fake API, so a drift from packages/contracts/src/learning.ts fails here.
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const SUBJECT_IDS = {
  math: '11111111-1111-4111-8111-111111111101',
  reading: '11111111-1111-4111-8111-111111111102',
  spelling_vocabulary: '11111111-1111-4111-8111-111111111103',
  grammar_writing: '11111111-1111-4111-8111-111111111104',
  science: '11111111-1111-4111-8111-111111111105',
  social_studies: '11111111-1111-4111-8111-111111111106',
} as const;
const MUSIC = '11111111-1111-4111-8111-111111111107';
const TEST_DATE = '22222222-2222-4222-8222-222222222201';
const SET = '33333333-3333-4333-8333-333333333301';
const ITEM_1 = '44444444-4444-4444-8444-444444444401';
const ITEM_2 = '44444444-4444-4444-8444-444444444402';
const EXPORT = '55555555-5555-4555-8555-555555555501';
const AT = '2026-09-20T15:00:00.000Z';

const family = {
  id: '99999999-9999-4999-8999-999999999999',
  displayName: 'Test family',
  timezone: 'America/New_York',
  paidSlots: 2,
  billingConflict: null,
  managingChannel: null,
  children: [
    { id: RILEY, nickname: 'Riley', gradeLevel: 4, ageBand: '8-10', status: 'active' },
    { id: SAM, nickname: 'Sam', gradeLevel: 2, ageBand: '5-7', status: 'active' },
  ],
};

function subjects(): ChildSubject[] {
  return [
    {
      id: SUBJECT_IDS.math,
      subjectKey: 'math',
      displayName: 'Math',
      enabled: true,
      generatedPractice: true,
    },
    {
      id: SUBJECT_IDS.reading,
      subjectKey: 'reading',
      displayName: 'Reading',
      enabled: true,
      generatedPractice: true,
    },
    {
      id: SUBJECT_IDS.spelling_vocabulary,
      subjectKey: 'spelling_vocabulary',
      displayName: 'Spelling & Vocabulary',
      enabled: true,
      generatedPractice: true,
    },
    {
      id: SUBJECT_IDS.grammar_writing,
      subjectKey: 'grammar_writing',
      displayName: 'Grammar & Writing',
      enabled: true,
      generatedPractice: true,
    },
    {
      id: SUBJECT_IDS.science,
      subjectKey: 'science',
      displayName: 'Science',
      enabled: false,
      generatedPractice: true,
    },
    {
      id: SUBJECT_IDS.social_studies,
      subjectKey: 'social_studies',
      displayName: 'Social Studies',
      enabled: true,
      generatedPractice: true,
    },
  ];
}

function schedule(overrides: Partial<LearningScheduleResponse> = {}): LearningScheduleResponse {
  return {
    schedule: {
      reviewWeekday: 4,
      reviewLocalTime: '16:00',
      reviewQuestionsPerSubject: 8,
      dailyLocalTime: '15:30',
      dailyQuestionCount: 5,
      pause: null,
      quietHours: null,
      childRemindersPermitted: false,
      scheduleVersion: 1,
    },
    timezone: 'America/New_York',
    nextReviewReleases: [
      {
        subjectKey: 'math',
        weekKey: '2026-W39',
        releaseAt: '2026-09-24T20:00:00.000Z',
        reason: 'default_schedule',
        testDate: null,
      },
      {
        subjectKey: 'reading',
        weekKey: '2026-W40',
        releaseAt: '2026-09-30T20:00:00.000Z',
        reason: 'test_date_eve',
        testDate: '2026-10-01',
      },
    ],
    dailyPractice: {
      localDate: '2026-09-24',
      state: 'not_yet_released',
      releaseAt: '2026-09-24T19:30:00.000Z',
    },
    pointsPolicy: { expireEarnedPoints: false, penalizeMissedDays: false },
    ...overrides,
  };
}

const mathTest: TestDate = {
  id: TEST_DATE,
  subjectId: SUBJECT_IDS.math,
  subjectKey: 'math',
  testDate: '2026-10-02',
  scopeNotes: 'comparing fractions',
  matchedSkills: [{ skill: 'math.fractions_compare', label: 'Comparing fractions' }],
};

function skills(overrides: Partial<SkillsResponse> = {}): SkillsResponse {
  return {
    childId: RILEY,
    skills: [
      {
        subjectKey: 'math',
        skill: 'math.add_two_digit',
        label: 'Two-digit addition',
        status: 'strong',
        statusLabel: 'Strong (still reviewed from time to time)',
        distinctQuestions: 9,
        distinctIndependentQuestions: 8,
        initialAccuracy: 0.875,
        eventualCompletionRate: 1,
        lastPracticedAt: AT,
      },
      {
        subjectKey: 'math',
        skill: 'math.fractions_compare',
        label: 'Comparing fractions',
        status: 'needs_practice',
        statusLabel: 'Needs practice',
        distinctQuestions: 7,
        distinctIndependentQuestions: 6,
        initialAccuracy: 0.5,
        eventualCompletionRate: 0.83,
        lastPracticedAt: AT,
      },
      {
        subjectKey: 'reading',
        skill: 'reading.sequence',
        label: 'Order of events',
        status: 'not_enough_evidence',
        statusLabel: 'Not enough evidence',
        distinctQuestions: 3,
        distinctIndependentQuestions: 2,
        initialAccuracy: 0.5,
        eventualCompletionRate: 1,
        lastPracticedAt: null,
      },
    ],
    evidenceRule:
      'Skills are summarized from first, unaided tries on different questions. This is an educational signal, not a diagnosis or a test score.',
    coverage: {
      subjects: [
        {
          subjectKey: 'math',
          supportedSkills: [{ skill: 'math.add_two_digit', label: 'Two-digit addition' }],
          unsupported: ['Geometric proofs'],
        },
      ],
      general: ['Grades 9-12 use grade-8 items.'],
    },
    ...overrides,
  };
}

function practiceSets(): PracticeSets {
  return {
    sets: [
      {
        id: SET,
        kind: 'thursday_review',
        status: 'in_progress',
        subjectKey: 'math',
        localDate: null,
        reviewWeek: '2026-W39',
        version: 1,
        optional: false,
        readyAt: AT,
        releaseAt: '2026-09-24T20:00:00.000Z',
        mix: { weakness: 6, cumulative: 2, requested: 8 },
        notes: [
          {
            code: 'FILLED',
            message:
              'Two questions come from current material because fewer weaker skills showed up.',
          },
        ],
        items: [
          {
            id: ITEM_1,
            position: 1,
            subjectKey: 'math',
            skill: 'math.fractions_compare',
            topic: 'Comparing fractions',
            category: 'weakness',
            prompt: {
              text: 'Which fraction is larger?',
              choices: ['2/3', '3/5'],
              passage: null,
              responseFormat: 'choice',
              unitHint: null,
            },
            progress: { status: 'correct', attempts: 1, firstTry: 'correct' },
          },
          {
            id: ITEM_2,
            position: 2,
            subjectKey: 'math',
            skill: 'math.measurement',
            topic: 'Measurement',
            category: 'cumulative',
            prompt: {
              text: 'A ribbon is cut into two pieces. How long is the second piece?',
              choices: null,
              passage: null,
              responseFormat: 'number',
              unitHint: 'cm',
            },
            progress: { status: 'try_again', attempts: 1, firstTry: 'incorrect' },
          },
        ],
      },
    ],
  };
}

const answerKey: AnswerKeyResponse = {
  setId: SET,
  items: [
    { itemId: ITEM_2, position: 2, answer: '7 cm', explanation: 'Subtract the first piece.' },
    { itemId: ITEM_1, position: 1, answer: 'A: 2/3', explanation: 'Use a common denominator.' },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: Call) => unknown;

/** Default responses for every route the planner reads, keyed by path (query string included). */
function defaultGet(path: string): unknown {
  if (path === '/v1/family') return family;
  const match = /^\/v1\/children\/([^/]+)\/([a-z-]+)(\?.*)?$/.exec(path);
  const riley = match?.[1] === RILEY;
  const routes: Record<string, () => unknown> = {
    subjects: () => ({ subjects: subjects() }),
    'learning-schedule': () => schedule(),
    'test-dates': () => ({ testDates: riley ? [mathTest] : [] }),
    skills: () => (riley ? skills() : skills({ childId: SAM, skills: [] })),
    'practice-sets': () => (riley ? practiceSets() : { sets: [] }),
  };
  const route = match?.[2] === undefined ? undefined : routes[match[2]];
  if (route) return route();
  throw new Error(`unexpected GET ${path}`);
}

/** Fake API that validates fixtures and responses through the real contract schemas. */
function fakeApi(options: { get?: (path: string) => unknown; send?: Handler } = {}) {
  const gets: string[] = [];
  const sends: Call[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      gets.push(path);
      try {
        const override = options.get?.(path);
        const value = override === undefined ? defaultGet(path) : override;
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

// Vitest globals are off, so Testing Library cannot register its automatic cleanup.
afterEach(() => {
  cleanup();
});

const stepUp = () =>
  new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN to continue', 403);

async function region(name: string | RegExp) {
  return screen.findByRole('region', { name });
}

describe('LearningPlannerPage (spec P7, P8, P10; AC_LEARNING_01/02/07/10, AC_UX_02)', () => {
  it('needs a signed-in parent and makes no API call otherwise', async () => {
    const { api, gets } = fakeApi();
    renderPage(<LearningPlannerPage />, { api, auth: unconfiguredAuth });
    expect(await screen.findByText(/Parent sign-in isn’t available yet/)).toBeTruthy();
    expect(gets).toEqual([]);
  });

  it('offers the Children page when the family has no children yet', async () => {
    const { api } = fakeApi({
      get: (p) => (p === '/v1/family' ? { ...family, children: [] } : undefined),
    });
    renderPage(<LearningPlannerPage />, { api });
    const empty = await region('No children yet');
    expect(within(empty).getByRole('link', { name: 'Children page' }).getAttribute('href')).toBe(
      '/app/children',
    );
  });

  it('shows one child at a time and switching child loads only that child’s data', async () => {
    const { api, gets } = fakeApi();
    renderPage(<LearningPlannerPage />, { api });
    expect(await screen.findByRole('heading', { name: 'Learning planner' })).toBeTruthy();
    const plan = await region('Learning plan for Riley');
    expect(await within(plan).findByRole('checkbox', { name: 'Math' })).toBeTruthy();
    await waitFor(() =>
      expect(gets).toEqual(
        expect.arrayContaining([
          `/v1/children/${RILEY}/subjects`,
          `/v1/children/${RILEY}/learning-schedule`,
          `/v1/children/${RILEY}/test-dates`,
          `/v1/children/${RILEY}/skills`,
          `/v1/children/${RILEY}/practice-sets`,
        ]),
      ),
    );
    expect(gets.some((p) => p.includes(SAM))).toBe(false);

    await userEvent.selectOptions(screen.getByLabelText('Child'), SAM);
    expect(await region('Learning plan for Sam')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Learning plan for Riley' })).toBeNull();
    await waitFor(() => expect(gets).toContain(`/v1/children/${SAM}/skills`));
    expect(await screen.findByText(/No practice answers yet/)).toBeTruthy();
  });

  it('turns a subject off with PATCH and explains that earned points are kept', async () => {
    const { api, sends } = fakeApi({
      send: () => ({ subject: { ...subjects()[0]!, enabled: false } }),
    });
    renderPage(<LearningPlannerPage />, { api });
    const subjectsCard = await region('Subjects');
    await userEvent.click(await within(subjectsCard).findByRole('checkbox', { name: 'Math' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PATCH',
      path: `/v1/children/${RILEY}/subjects`,
      body: { subjectId: SUBJECT_IDS.math, enabled: false },
    });
    expect(
      await within(subjectsCard).findByText(/Math is off.*Points already earned are kept/),
    ).toBeTruthy();
    // A disabled subject is shown as off in text, not colour alone.
    const science = within(subjectsCard).getByRole('checkbox', { name: 'Science' });
    expect(science).toHaveProperty('checked', false);
  });

  it('adds a custom subject after client validation and shows the server’s duplicate message', async () => {
    let calls = 0;
    const { api, sends } = fakeApi({
      send: () => {
        calls += 1;
        return calls === 1
          ? {
              subject: {
                id: MUSIC,
                subjectKey: 'custom',
                displayName: 'Music',
                enabled: true,
                generatedPractice: false,
              },
            }
          : new ApiRequestError('CONFLICT', 'That subject already exists', 409);
      },
    });
    renderPage(<LearningPlannerPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a custom subject' });
    await userEvent.click(within(form).getByRole('button', { name: 'Add subject' }));
    expect(await within(form).findByText(/Name the subject/)).toBeTruthy();
    await userEvent.type(within(form).getByLabelText('Add a custom subject'), 'math');
    await userEvent.click(within(form).getByRole('button', { name: 'Add subject' }));
    expect(await within(form).findByText(/already has a subject called/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText('Add a custom subject'));
    await userEvent.type(within(form).getByLabelText('Add a custom subject'), '  Music ');
    await userEvent.click(within(form).getByRole('button', { name: 'Add subject' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/children/${RILEY}/subjects`,
      body: { subjectKey: 'custom', displayName: 'Music' },
    });
    expect(await screen.findByText(/Added Music/)).toBeTruthy();

    await userEvent.type(within(form).getByLabelText('Add a custom subject'), 'Chess');
    await userEvent.click(within(form).getByRole('button', { name: 'Add subject' }));
    expect(await screen.findByText('That subject already exists')).toBeTruthy();
  });

  it('shows schedule times in the family zone with its name, and releases in that zone', async () => {
    const { api } = fakeApi();
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Practice and review schedule');
    expect(
      await within(card).findByText(/family’s time zone: America\/New_York \((EDT|EST)\)/),
    ).toBeTruthy();
    expect(within(card).getByLabelText('Review day')).toHaveProperty('value', '4');
    expect(within(card).getByLabelText('Review time (America/New_York)')).toHaveProperty(
      'value',
      '16:00',
    );
    const upcoming = within(card).getByRole('region', { name: 'Coming up for Riley' });
    expect(within(upcoming).getByText(/Thu, Sep 24, 4:00\sPM EDT/)).toBeTruthy();
    expect(within(upcoming).getByText(/moved before the test on Thu, Oct 1, 2026/)).toBeTruthy();
    expect(within(upcoming).getByText(/opens Thu, Sep 24, 3:30\sPM EDT/)).toBeTruthy();
    expect(within(card).getByText(/never removes points Riley already earned/)).toBeTruthy();
  });

  it('validates the schedule on the client and saves the exact contract body', async () => {
    const { api, sends } = fakeApi({
      send: (call) => {
        const body = call.body as LearningScheduleResponse['schedule'];
        return schedule({ schedule: { ...body, scheduleVersion: 2 } });
      },
    });
    renderPage(<LearningPlannerPage />, { api });
    const form = await screen.findByRole('form', { name: 'Practice and review schedule' });
    const daily = within(form).getByLabelText('Daily questions');
    await userEvent.clear(daily);
    await userEvent.type(daily, '11');
    await userEvent.click(within(form).getByRole('checkbox', { name: /Pause daily practice/ }));
    fireEvent.change(within(form).getByLabelText('First day of the pause'), {
      target: { value: '2026-12-31' },
    });
    fireEvent.change(within(form).getByLabelText('Last day of the pause'), {
      target: { value: '2026-12-20' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Save schedule' }));
    expect(await within(form).findByText(/between 3 and 10 daily questions/)).toBeTruthy();
    expect(within(form).getByText(/must not end before it starts/)).toBeTruthy();
    expect(daily.getAttribute('aria-invalid')).toBe('true');
    expect(sends).toHaveLength(0);

    await userEvent.clear(daily);
    await userEvent.type(daily, '7');
    fireEvent.change(within(form).getByLabelText('Last day of the pause'), {
      target: { value: '2027-01-02' },
    });
    await userEvent.selectOptions(within(form).getByLabelText('Review day'), '3');
    fireEvent.change(within(form).getByLabelText('Review time (America/New_York)'), {
      target: { value: '17:15' },
    });
    await userEvent.click(within(form).getByRole('checkbox', { name: /Set quiet hours/ }));
    fireEvent.change(within(form).getByLabelText('Quiet hours start (America/New_York)'), {
      target: { value: '20:00' },
    });
    fireEvent.change(within(form).getByLabelText('Quiet hours end (America/New_York)'), {
      target: { value: '07:00' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'PUT',
      path: `/v1/children/${RILEY}/learning-schedule`,
      body: {
        reviewWeekday: 3,
        reviewLocalTime: '17:15',
        reviewQuestionsPerSubject: 8,
        dailyLocalTime: '15:30',
        dailyQuestionCount: 7,
        pause: { from: '2026-12-31', to: '2027-01-02' },
        quietHours: { start: '20:00', end: '07:00' },
        childRemindersPermitted: false,
      },
    });
    expect(await within(form).findByText('Schedule saved for Riley.')).toBeTruthy();
  });

  it('adds a test date with a strict body, shows recognized topics, and removes one', async () => {
    const { api, sends, gets } = fakeApi({
      send: (call) =>
        call.method === 'DELETE'
          ? null
          : {
              testDate: {
                ...mathTest,
                id: '22222222-2222-4222-8222-222222222202',
                subjectId: SUBJECT_IDS.reading,
                subjectKey: 'reading',
                testDate: '2026-10-09',
                scopeNotes: 'order of events',
                matchedSkills: [{ skill: 'reading.sequence', label: 'Order of events' }],
              },
            },
    });
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Upcoming tests');
    const saved = await within(card).findByRole('list', { name: 'Saved test dates' });
    expect(within(saved).getByText(/Math · Fri, Oct 2, 2026/)).toBeTruthy();
    expect(within(saved).getByText(/Practice will include: Comparing fractions/)).toBeTruthy();

    const form = within(card).getByRole('form', { name: 'Add a test date' });
    // Only subjects that are on can get a test date (Science is off).
    expect(within(form).queryByRole('option', { name: 'Science' })).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Save test date' }));
    expect(await within(form).findByText('Enter the test date.')).toBeTruthy();
    expect(sends).toHaveLength(0);

    await userEvent.selectOptions(within(form).getByLabelText('Subject'), SUBJECT_IDS.reading);
    fireEvent.change(within(form).getByLabelText('Test date'), { target: { value: '2026-10-09' } });
    await userEvent.type(within(form).getByLabelText(/What the test covers/), ' order of events ');
    await userEvent.click(within(form).getByRole('button', { name: 'Save test date' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/children/${RILEY}/test-dates`,
      body: {
        subjectId: SUBJECT_IDS.reading,
        testDate: '2026-10-09',
        scopeNotes: 'order of events',
      },
    });
    expect(await within(card).findByText(/Topics recognized: Order of events/)).toBeTruthy();
    // The schedule's upcoming releases are refreshed after a test date change.
    await waitFor(() =>
      expect(gets.filter((p) => p === `/v1/children/${RILEY}/learning-schedule`).length).toBe(2),
    );

    await userEvent.click(
      within(card).getByRole('button', { name: 'Remove the Math test on Fri, Oct 2, 2026' }),
    );
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toEqual({
      method: 'DELETE',
      path: `/v1/children/${RILEY}/test-dates/${TEST_DATE}`,
      body: undefined,
    });
    expect(await within(card).findByText(/Removed the Math test/)).toBeTruthy();
  });

  it('saves a teacher spelling list within the per-kind limit and reports the words found', async () => {
    const { api, sends } = fakeApi({
      send: () => ({
        material: {
          id: '66666666-6666-4666-8666-666666666601',
          kind: 'spelling_list',
          subjectId: SUBJECT_IDS.spelling_vocabulary,
          createdAt: AT,
          spellingWords: 3,
          matchedSkills: [{ skill: 'spelling.teacher_list', label: 'Teacher spelling list' }],
        },
      }),
    });
    renderPage(<LearningPlannerPage />, { api });
    const form = await screen.findByRole('form', { name: 'Add a spelling list or notes' });
    expect(within(form).getByLabelText('Subject')).toHaveProperty(
      'value',
      SUBJECT_IDS.spelling_vocabulary,
    );
    const text = within(form).getByLabelText('Teacher’s spelling list');
    expect(text.getAttribute('maxlength')).toBe('2000');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Type the list or notes first/)).toBeTruthy();
    fireEvent.change(text, { target: { value: 'a'.repeat(2001) } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/at most 2000 characters/)).toBeTruthy();
    expect(sends).toHaveLength(0);

    fireEvent.change(text, { target: { value: 'planet\nrocket\nsilver' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      method: 'POST',
      path: `/v1/children/${RILEY}/study-materials`,
      body: {
        kind: 'spelling_list',
        text: 'planet\nrocket\nsilver',
        subjectId: SUBJECT_IDS.spelling_vocabulary,
      },
    });
    expect(await screen.findByText(/Found 3 spelling words/)).toBeTruthy();
    // Notes allow the longer limit.
    await userEvent.selectOptions(within(form).getByLabelText('What is it?'), 'taught_notes');
    expect(within(form).getByLabelText('Notes on what was taught').getAttribute('maxlength')).toBe(
      '4000',
    );
    expect(within(form).getByLabelText('Subject')).toHaveProperty('value', '');
  });

  it('skill dashboard: evidence labels, first try vs after help, no diagnosis, no sibling', async () => {
    const { api } = fakeApi();
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Riley’s skills');
    expect(
      within(card).getByText('“Needs practice” is a learning signal, not a diagnosis.'),
    ).toBeTruthy();
    const math = await within(card).findByRole('region', { name: 'Math skills' });
    expect(within(math).getByRole('heading', { name: 'Strengths' })).toBeTruthy();
    expect(within(math).getByRole('heading', { name: 'Practice areas' })).toBeTruthy();
    const fractions = within(math).getByRole('listitem', {
      name: 'Comparing fractions: Needs practice',
    });
    expect(within(fractions).getByText('First try, without help:')).toBeTruthy();
    expect(within(fractions).getByText('50%')).toBeTruthy();
    expect(within(fractions).getByText('Finished after help or retries:')).toBeTruthy();
    expect(within(fractions).getByText('83%')).toBeTruthy();

    const reading = within(card).getByRole('region', { name: 'Reading skills' });
    const sequence = within(reading).getByRole('listitem', {
      name: 'Order of events: Not enough evidence',
    });
    expect(
      within(sequence).getByText(/2 questions answered independently \(5 needed/),
    ).toBeTruthy();

    expect(card.textContent).not.toMatch(/master/i);
    expect(card.textContent).not.toMatch(/Sam/);
    expect(within(card).getByText(/Not covered yet: Geometric proofs/)).toBeTruthy();
  });

  it('shows questions, and the answer key only after a PIN step-up', async () => {
    let keyCalls = 0;
    const { api, gets } = fakeApi({
      get: (path) => {
        if (!path.endsWith('/answer-key')) return undefined;
        keyCalls += 1;
        return keyCalls === 1 ? stepUp() : answerKey;
      },
    });
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Practice sets and reviews');
    const title = 'Weekly review · Math · week 2026-W39';
    const set = await within(card).findByRole('listitem', { name: title });
    expect(within(set).getByText(/Status: In progress · 1 of 2 questions finished/)).toBeTruthy();
    expect(
      within(set).getByText(/Mix: 6 from this week’s weaker skills, 2 cumulative review/),
    ).toBeTruthy();
    expect(within(set).getByText(/fewer weaker skills showed up/)).toBeTruthy();

    await userEvent.click(within(set).getByRole('button', { name: `Show questions: ${title}` }));
    expect(within(set).getByText('Which fraction is larger?')).toBeTruthy();
    expect(within(set).getByText('A. 2/3')).toBeTruthy();
    expect(within(set).getByText('Answer in cm.')).toBeTruthy();
    // The questions view never contains an answer.
    expect(set.textContent).not.toContain('7 cm');

    await userEvent.click(within(set).getByRole('button', { name: `Show answer key: ${title}` }));
    expect(
      await within(set).findByText(/Showing the answer key needs a recent PIN unlock/),
    ).toBeTruthy();
    expect(
      within(set)
        .getByRole('link', { name: /Unlock on the Security page/ })
        .getAttribute('href'),
    ).toBe('/app/security');
    expect(set.textContent).not.toContain('7 cm');

    await userEvent.click(within(set).getByRole('button', { name: `Show answer key: ${title}` }));
    const key = await within(set).findByRole('region', { name: `Answer key: ${title}` });
    const answers = within(key).getAllByRole('listitem');
    expect(answers.map((li) => li.textContent)).toEqual([
      'A: 2/3 — Use a common denominator.',
      '7 cm — Subtract the first piece.',
    ]);
    expect(gets.filter((p) => p === `/v1/practice-sets/${SET}/answer-key`)).toHaveLength(2);

    await userEvent.click(within(set).getByRole('button', { name: `Hide answer key: ${title}` }));
    expect(within(set).queryByRole('region', { name: `Answer key: ${title}` })).toBeNull();
    expect(set.textContent).not.toContain('7 cm');
  });

  it('requests a questions-only PDF and a separate answer-key PDF; explains a missing step-up', async () => {
    let calls = 0;
    const { api, sends } = fakeApi({
      send: (call) => {
        calls += 1;
        if (calls === 2) return stepUp();
        const variant = (call.body as { variant: string }).variant;
        return {
          exportId: EXPORT,
          kind: variant === 'answer_key' ? 'review_answer_key_pdf' : 'review_questions_pdf',
          status: 'queued',
        };
      },
    });
    renderPage(<LearningPlannerPage />, { api });
    const title = 'Weekly review · Math · week 2026-W39';
    const set = await within(await region('Practice sets and reviews')).findByRole('listitem', {
      name: title,
    });
    await userEvent.click(
      within(set).getByRole('button', { name: `Request questions-only PDF: ${title}` }),
    );
    expect(
      await within(set).findByText(/Preparing the questions-only PDF \(no answers\)/),
    ).toBeTruthy();
    expect(
      within(set)
        .getByRole('link', { name: /Privacy/ })
        .getAttribute('href'),
    ).toBe('/app/privacy');

    await userEvent.click(
      within(set).getByRole('button', { name: `Request parent answer-key PDF: ${title}` }),
    );
    expect(await within(set).findByText(/Exporting a PDF needs a recent PIN unlock/)).toBeTruthy();

    await userEvent.click(
      within(set).getByRole('button', { name: `Request parent answer-key PDF: ${title}` }),
    );
    expect(await within(set).findByText(/Preparing the parent answer-key PDF/)).toBeTruthy();
    expect(sends.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/v1/exports/review-pdf', { setId: SET, variant: 'questions' }],
      ['POST', '/v1/exports/review-pdf', { setId: SET, variant: 'answer_key' }],
      ['POST', '/v1/exports/review-pdf', { setId: SET, variant: 'answer_key' }],
    ]);
  });

  it('filters sets by kind through the API query', async () => {
    const { api, gets } = fakeApi();
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Practice sets and reviews');
    await within(card).findByRole('listitem', { name: /Weekly review/ });
    await userEvent.selectOptions(within(card).getByLabelText('Show'), 'daily');
    await waitFor(() => expect(gets).toContain(`/v1/children/${RILEY}/practice-sets?kind=daily`));
  });

  it('shows an error with a retry when a section fails, and keeps the rest of the page', async () => {
    let failures = 0;
    const { api, gets } = fakeApi({
      get: (path) => {
        if (!path.endsWith('/skills')) return undefined;
        failures += 1;
        return failures === 1
          ? new ApiRequestError('NETWORK', 'You appear to be offline.', 0)
          : undefined;
      },
    });
    renderPage(<LearningPlannerPage />, { api });
    const card = await region('Riley’s skills');
    expect(
      await within(card).findByText(/couldn’t load Riley’s skills. You appear to be offline/),
    ).toBeTruthy();
    expect(await screen.findByRole('form', { name: 'Practice and review schedule' })).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await within(card).findByRole('region', { name: 'Math skills' })).toBeTruthy();
    expect(gets.filter((p) => p.endsWith('/skills'))).toHaveLength(2);
  });
});

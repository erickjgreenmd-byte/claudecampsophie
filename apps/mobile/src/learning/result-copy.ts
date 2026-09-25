import type {
  ChildPracticeSet,
  ChildPracticeToday,
  ChildReviews,
  PracticeAnswerResponse,
} from '@pencillift/contracts';
import { ApiRequestError, isRequestTimeout } from '@pencillift/contracts/client';

/**
 * Child-facing copy for practice and review (spec P6, P7, P9, P14). Pure and unit-tested.
 * "Correct" / "Try again" always come with an icon AND text; nothing here ever contains an answer
 * (the server never sends one); after three unsuccessful tries the child is offered method practice
 * or a grown-up's help without being locked out; missed days and pauses never cost points.
 */

export type FeedbackTone = 'correct' | 'try_again' | 'unclear' | 'help';

export interface AnswerFeedback {
  readonly tone: FeedbackTone;
  /** A symbol shown next to the title; the title carries the meaning for screen readers. */
  readonly icon: string;
  readonly title: string;
  readonly message: string;
  /** Read aloud by screen readers when the feedback appears. */
  readonly a11yLabel: string;
  /** True when checking this question again is useful (the server will grade it). */
  readonly canRetry: boolean;
  /** True when "Practice the method" / "Ask a grown-up" should be offered. */
  readonly showHelpOptions: boolean;
}

function pointsSentence(points: number): string {
  return points > 0 ? ` You earned ${points} ${points === 1 ? 'point' : 'points'}.` : '';
}

const TRY_AGAIN_MESSAGES = [
  'Not quite yet. Read the question again and give it another go.',
  'Keep going! Check each step of your work, then try once more.',
] as const;

export function answerFeedback(response: PracticeAnswerResponse): AnswerFeedback {
  if (response.result === 'correct') {
    const message =
      (response.attemptNumber <= 1 ? 'Great thinking!' : 'You kept going and got it!') +
      pointsSentence(response.pointsAwarded);
    return {
      tone: 'correct',
      icon: '✓',
      title: 'Correct',
      message,
      a11yLabel: `Correct. ${message}`,
      canRetry: false,
      showHelpOptions: false,
    };
  }
  if (response.offerHelp) {
    const message =
      response.result === 'try_again'
        ? 'That was a tricky one, and you kept trying.' +
          pointsSentence(response.pointsAwarded) +
          ' Let’s practice the method, or ask a grown-up to help. You can also go on to the next question.'
        : 'You tried this one three times. Let’s practice the method, or ask a grown-up to help. You can go on to the next question.';
    // Spec P6: the verdict is still "Try again" (icon + text); the next step is help, not guessing.
    const tried = response.result === 'try_again';
    const title = tried ? 'Try again' : 'Let’s get some help';
    return {
      tone: 'help',
      icon: tried ? '↻' : '★',
      title,
      message,
      a11yLabel: `${title}. ${message}`,
      canRetry: false,
      showHelpOptions: true,
    };
  }
  if (response.result === 'try_again') {
    const message =
      TRY_AGAIN_MESSAGES[Math.min(Math.max(response.attemptNumber, 1), 2) - 1]! +
      pointsSentence(response.pointsAwarded);
    return {
      tone: 'try_again',
      icon: '↻',
      title: 'Try again',
      message,
      a11yLabel: `Try again. ${message}`,
      canRetry: true,
      showHelpOptions: false,
    };
  }
  const message =
    'Type just your final answer, like a number or a word, then check it again. If it keeps happening, ask a grown-up to review this.';
  return {
    tone: 'unclear',
    icon: '?',
    title: 'Let’s get a clearer answer',
    message,
    a11yLabel: `Let’s get a clearer answer. ${message}`,
    canRetry: true,
    showHelpOptions: false,
  };
}

/** Feedback for a question that was already finished when the set was opened. */
export function finishedItemFeedback(status: 'correct' | 'help_offered'): AnswerFeedback {
  if (status === 'correct') {
    const message = 'You already solved this one. Nice work!';
    return {
      tone: 'correct',
      icon: '✓',
      title: 'Correct',
      message,
      a11yLabel: `Correct. ${message}`,
      canRetry: false,
      showHelpOptions: false,
    };
  }
  const message =
    'You tried this one three times. Practice the method, or ask a grown-up to help. You can go on to the next question.';
  return {
    tone: 'help',
    icon: '★',
    title: 'Let’s get some help',
    message,
    a11yLabel: `Let’s get some help. ${message}`,
    canRetry: false,
    showHelpOptions: true,
  };
}

/**
 * General method steps by subject. They describe HOW to work, contain no numbers, letters or
 * words from any question, and so cannot reveal an answer (spec P6, AC_GRADING_07).
 */
const METHOD_STEPS: Readonly<Record<string, readonly string[]>> = {
  math: [
    'Read the question slowly and find what it asks for.',
    'Write down the numbers you know.',
    'Decide what to do: add, subtract, multiply or divide.',
    'Try a smaller, easier example first, then use the same steps.',
    'Check your work by estimating or working backwards.',
  ],
  reading: [
    'Read the passage again, a little at a time.',
    'Find the sentences that talk about the question.',
    'Look for clue words like first, next, then and finally.',
    'Say the answer in your own words before you type it.',
  ],
  spelling_vocabulary: [
    'Say the word slowly and listen for each sound.',
    'Clap the syllables.',
    'Write a letter or letters for each sound you hear.',
    'Look for a spelling pattern you know.',
    'Look at your word: does it look right?',
  ],
  grammar_writing: [
    'Read the sentence out loud.',
    'Find the naming words and the action words.',
    'Check capital letters and end marks.',
    'Read it again: does it sound right?',
  ],
  science: [
    'Find the key science word in the question.',
    'Think about what you learned or saw in an experiment.',
    'Cross out choices that don’t fit.',
    'Pick the choice with the best reason.',
  ],
  social_studies: [
    'Find the key word, like a place, a time or a person.',
    'Think about what you learned in class.',
    'Cross out choices that don’t fit.',
    'Pick the best answer and say why.',
  ],
};

const DEFAULT_METHOD_STEPS = [
  'Read the question slowly.',
  'Find what it asks for.',
  'Work one small step at a time.',
  'Check your work.',
] as const;

export function methodSteps(subjectKey: string): readonly string[] {
  return METHOD_STEPS[subjectKey] ?? DEFAULT_METHOD_STEPS;
}

export const ASK_GROWN_UP_COPY =
  'Show this question to a grown-up. They can help you with the steps. Asking for help is a smart move!';

export function completionCopy(
  kind: ChildPracticeSet['kind'],
  pointsThisTime: number,
): { title: string; message: string } {
  const title =
    kind === 'daily'
      ? 'You finished today’s practice!'
      : kind === 'top_up'
        ? 'You finished the extra practice!'
        : 'You finished this review section!';
  const earned = pointsThisTime > 0 ? `You earned ${pointsThisTime} points this time. ` : '';
  return { title, message: `${earned}Great work sticking with it.` };
}

export interface StateCopy {
  readonly title: string;
  readonly message: string;
}

/** Copy for today's practice when no set is on screen. `formatTime` shows an instant locally. */
export function todayStateCopy(
  today: Pick<ChildPracticeToday, 'state' | 'releaseAt'>,
  now: Date,
  formatTime: (iso: string) => string,
): StateCopy {
  switch (today.state) {
    case 'preparing':
      return {
        title: 'Getting your practice ready',
        message: 'Your questions are being made. Check back in a minute.',
      };
    case 'paused':
      return {
        title: 'Practice is taking a break',
        message: 'A grown-up paused daily practice for now. Your points are safe.',
      };
    case 'not_scheduled':
    case 'available':
      if (today.releaseAt !== null && Date.parse(today.releaseAt) > now.getTime()) {
        return {
          title: 'Practice opens later',
          message: `Today’s practice opens at ${formatTime(today.releaseAt)}.`,
        };
      }
      return {
        title: 'No practice right now',
        message: 'There’s nothing to practice right now. Check again later.',
      };
  }
}

export function reviewStateCopy(state: ChildReviews['state']): StateCopy | null {
  switch (state) {
    case 'available':
      return null;
    case 'preparing':
      return {
        title: 'Getting your review ready',
        message: 'Your weekly review is being made. Check back soon.',
      };
    case 'not_scheduled':
      return {
        title: 'No review yet',
        message: 'Your weekly review shows up here on review day.',
      };
  }
}

const ERROR_COPY: Readonly<Partial<Record<ApiRequestError['code'], string>>> = {
  NETWORK: 'You seem to be offline. Try again when you’re connected.',
  UNAUTHENTICATED: 'Ask a grown-up to connect this device again.',
  NOT_FOUND: 'That question isn’t here any more. Let’s load your practice again.',
  RATE_LIMITED: 'Let’s take a little break and try again soon.',
  FORBIDDEN: 'Ask a grown-up for help with this device.',
  CHILD_MODE_FORBIDDEN: 'Ask a grown-up for help with this device.',
};

/** Calm copy for load and submit failures; never raw server text. */
export function childLearningError(error: unknown): string {
  if (isRequestTimeout(error)) return 'This is taking longer than usual. Let’s try again.';
  const known = error instanceof ApiRequestError ? ERROR_COPY[error.code] : undefined;
  return known ?? 'Something went wrong. Let’s try again.';
}

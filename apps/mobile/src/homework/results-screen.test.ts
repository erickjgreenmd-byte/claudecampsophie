import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_STATUSES } from '@pencillift/contracts';
import { statusView } from './result-view.ts';

/**
 * The child results screen imports react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read its source. They guard AC_SECURITY_02: when the safety
 * screen flagged an answer, the calm message is the page body (result-view.ts) and the flagged
 * question offers help that carries the question and the message shown.
 */
const resultsScreen = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(child)', 'results.tsx'),
  'utf8',
);

describe('child results screen shows safety help (AC_SECURITY_02)', () => {
  it('renders the status body, where the safety message and resources appear', () => {
    expect(resultsScreen).toMatch(/state\.data\.status\.body/);
  });

  it('a flagged question offers “Get help” with the question and its message attached', () => {
    expect(resultsScreen).toMatch(/q\.safety \?/);
    expect(resultsScreen).toMatch(/label="Get help"/);
    expect(resultsScreen).toMatch(/pathname: '\/help'/);
    expect(resultsScreen).toMatch(/questionId: q\.id, feedbackId: q\.safety!\.feedbackId/);
  });
});

/**
 * HUNT7-E-3: the screen decides whether to offer "Scan again" by comparing `status.title` to two
 * literals, so the copy and the button are coupled through a string the screen repeats. Both halves
 * are checked here: every literal the screen matches on is a title `statusView` really produces (a
 * renamed title cannot silently orphan the button), and the body shown beside that button names a
 * grown-up — because the re-scan the button starts can be refused outright, and `childUploadMessage`
 * answers those refusals with a grown-up and no money (apps/mobile/src/homework/upload.ts,
 * `RULE_COPY`: QUOTA_EXCEEDED, CONSENT_REQUIRED, CHILD_NOT_ACTIVE).
 */
describe('the child’s “Scan again” button and the copy beside it agree', () => {
  const offered = [...resultsScreen.matchAll(/state\.data\.status\.title === '([^']+)'/g)].map(
    (m) => m[1]!,
  );

  it('offers it for titles statusView produces, whose bodies name a grown-up', () => {
    // Not vacuous: the screen still keys the button on copy, and on exactly two titles.
    expect(offered).toHaveLength(2);
    for (const title of offered) {
      const views = ASSIGNMENT_STATUSES.map(statusView).filter((v) => v.title === title);
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) expect(view.body).toMatch(/grown-up/);
    }
  });
});

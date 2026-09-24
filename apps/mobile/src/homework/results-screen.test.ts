import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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

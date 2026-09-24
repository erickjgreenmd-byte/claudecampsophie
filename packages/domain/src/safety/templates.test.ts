import { describe, expect, it } from 'vitest';
import {
  CHILD_SAFETY_MESSAGE_MAX_LENGTH,
  FAMILY_HOLD_CATEGORIES,
  SAFETY_AGE_BANDS,
  SAFETY_RESOURCES_US,
  SAFETY_TEMPLATES_APPROVED,
  SAFETY_TEMPLATES_STATUS,
  SEVERE_SAFETY_CATEGORIES,
  childSafetyMessage,
  heldFromFamily,
  screenModelOutput,
} from './index.ts';

// Spec P4: calm, age-appropriate safety templates that never diagnose, never promise that a parent
// was alerted, never ask for secrecy and point to a trusted grown-up and US crisis resources.

const NO_ALERT_CLAIM =
  /\b(alerted|notified|we told|we have told|we(?:'|’)ve told|has been told|have been told|will be told|we sent|we emailed|we called|your (?:mom|dad|parent|parents|family) (?:knows|will know))\b/i;
const DIAGNOSIS = /\b(you (?:have|are|seem|might|may)\b.*\b(depress|anxiety|adhd|disorder|ill))/i;

describe('child safety message', () => {
  const combos = SAFETY_AGE_BANDS.flatMap((band) =>
    SEVERE_SAFETY_CATEGORIES.map((category) => [band, category] as const),
  );

  for (const [band, category] of combos) {
    it(`${band} / ${category}: calm, honest and pointing to help`, () => {
      const message = childSafetyMessage([category], band);
      expect(message.length).toBeGreaterThan(40);
      expect(message.length).toBeLessThanOrEqual(CHILD_SAFETY_MESSAGE_MAX_LENGTH);
      expect(message).toMatch(/grown-up you trust/i);
      expect(message).toContain(SAFETY_RESOURCES_US.emergency);
      expect(message).not.toMatch(NO_ALERT_CLAIM);
      expect(message).not.toMatch(DIAGNOSIS);
      expect(message).not.toMatch(/!/); // calm: no exclamation marks
      // The template itself never asks for secrecy, contact details or a companion relationship.
      const screened = screenModelOutput([message], { ageBand: band, context: {} });
      for (const forbidden of ['secrecy', 'personal_contact', 'companion_persona', 'diagnosis']) {
        expect(screened.categories).not.toContain(forbidden);
      }
    });
  }

  it('names 988 for self-harm and Childhelp for abuse, secrecy, sexual content and contact', () => {
    for (const band of SAFETY_AGE_BANDS) {
      expect(childSafetyMessage(['self_harm'], band)).toContain(SAFETY_RESOURCES_US.crisisLine);
      for (const category of ['abuse', 'sexual', 'secrecy', 'personal_contact'] as const) {
        expect(childSafetyMessage([category], band)).toContain(
          SAFETY_RESOURCES_US.childAbuseHotline,
        );
      }
    }
    const both = childSafetyMessage(['self_harm', 'abuse'], '11-13');
    expect(both).toContain('988');
    expect(both).toContain('1-800-422-4453');
  });

  it('never shows a possible victim the anger message (abuse-type codes take precedence)', () => {
    // "he said if I tell he will hurt my mom" is a victim's disclosure; the violence template's
    // "If you feel very angry..." is for a child who threatens someone.
    for (const band of SAFETY_AGE_BANDS) {
      for (const hold of ['abuse', 'sexual', 'secrecy', 'personal_contact'] as const) {
        const message = childSafetyMessage([hold, 'violence'], band);
        expect(message).not.toMatch(/angry/i);
        expect(message).toContain(SAFETY_RESOURCES_US.childAbuseHotline);
        expect(message).toContain(SAFETY_RESOURCES_US.emergency);
      }
      expect(childSafetyMessage(['violence'], band)).toMatch(/angry/i);
    }
  });

  it('uses simpler wording for the youngest children', () => {
    const young = childSafetyMessage(['self_harm'], '5-7');
    const older = childSafetyMessage(['self_harm'], '11-13');
    const avgWords = (s: string) => {
      const sentences = s.split(/[.?]\s+/).filter(Boolean);
      return s.split(/\s+/).length / sentences.length;
    };
    expect(avgWords(young)).toBeLessThan(avgWords(older));
    expect(young).toMatch(/a grown-up can/i);
  });

  it('is deterministic and falls back to the general message for an unknown band', () => {
    expect(childSafetyMessage(['violence'], '8-10')).toBe(childSafetyMessage(['violence'], '8-10'));
    expect(childSafetyMessage([], null)).toContain('911');
  });
});

describe('family hold (runbook 5.1)', () => {
  it('holds reports whose concern may involve the household, and only those', () => {
    expect(FAMILY_HOLD_CATEGORIES).toEqual(['abuse', 'sexual', 'secrecy']);
    expect(heldFromFamily(['abuse'])).toBe(true);
    expect(heldFromFamily(['self_harm', 'sexual'])).toBe(true);
    expect(heldFromFamily(['violence', 'secrecy'])).toBe(true);
    expect(heldFromFamily(['self_harm'])).toBe(false);
    expect(heldFromFamily(['violence'])).toBe(false);
    expect(heldFromFamily(['personal_contact'])).toBe(false);
    expect(heldFromFamily([])).toBe(false);
  });
});

describe('approval status', () => {
  it('the templates are drafts until the owner and an educator approve them', () => {
    expect(SAFETY_TEMPLATES_STATUS).toBe('draft_pending_owner_and_educator_approval');
    expect(SAFETY_TEMPLATES_APPROVED).toBe(false);
  });
});

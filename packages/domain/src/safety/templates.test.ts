import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHILD_SAFETY_MESSAGE_MAX_LENGTH,
  FAMILY_HOLD_CATEGORIES,
  HOUSEHOLD_SENSITIVE_CATEGORIES,
  SAFETY_AGE_BANDS,
  SAFETY_RESOURCES_US,
  SAFETY_TEMPLATES_APPROVED,
  SAFETY_TEMPLATES_STATUS,
  SAFETY_TEMPLATES_VERSION,
  SEVERE_SAFETY_CATEGORIES,
  childSafetyMessage,
  heldFromFamily,
  householdSensitive,
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
  // Owner decision (2026-09-25), a policy change and not a weakened test: this test asserted that
  // abuse, sexual and secrecy reports start held from the family. Now the parent is the only
  // person PencilLift sends a safety message to and the one who addresses the concern, so NO
  // report is held: the list is empty and heldFromFamily is false for every category set.
  it('holds no report from the family: the parent is the recipient of every flag', () => {
    expect(FAMILY_HOLD_CATEGORIES).toEqual([]);
    const n = SEVERE_SAFETY_CATEGORIES.length;
    for (let mask = 0; mask < 1 << n; mask += 1) {
      const set = SEVERE_SAFETY_CATEGORIES.filter((_, i) => (mask & (1 << i)) !== 0);
      expect(heldFromFamily(set), set.join('+')).toBe(false);
    }
  });
});

describe('household-sensitive categories (the printed-prompt rule, round 5)', () => {
  it('is the fixed set abuse, sexual, secrecy, independent of the hold list', () => {
    // The structural rule that these codes never come from a printed worksheet prompt (screen.ts
    // scan, CHK4-CS-4/5) keys on this set, so emptying the hold list did not switch it off.
    expect(HOUSEHOLD_SENSITIVE_CATEGORIES).toEqual(['abuse', 'sexual', 'secrecy']);
    expect(householdSensitive(['abuse'])).toBe(true);
    expect(householdSensitive(['self_harm', 'sexual'])).toBe(true);
    expect(householdSensitive(['violence', 'secrecy'])).toBe(true);
    expect(householdSensitive(['self_harm'])).toBe(false);
    expect(householdSensitive(['violence'])).toBe(false);
    expect(householdSensitive(['personal_contact'])).toBe(false);
    expect(householdSensitive([])).toBe(false);
    for (const category of HOUSEHOLD_SENSITIVE_CATEGORIES) {
      expect(FAMILY_HOLD_CATEGORIES).not.toContain(category);
    }
  });
});

describe('approval status', () => {
  it('the templates are drafts until the owner and an educator approve them', () => {
    expect(SAFETY_TEMPLATES_STATUS).toBe('draft_pending_owner_and_educator_approval');
    expect(SAFETY_TEMPLATES_APPROVED).toBe(false);
  });
});

describe('template version', () => {
  it('the version names the wording: any change to a message needs a new version (and approval)', () => {
    // RV-child-safety-14: Owner action #24 approves the wording by SAFETY_TEMPLATES_VERSION and every
    // safety row stores it as guard_version. A digest of every message (each category set, each age
    // band) is pinned per version, so editing the wording without a bump fails here.
    const messages: string[] = [];
    const n = SEVERE_SAFETY_CATEGORIES.length;
    for (const band of [...SAFETY_AGE_BANDS, null]) {
      for (let mask = 0; mask < 1 << n; mask += 1) {
        const set = SEVERE_SAFETY_CATEGORIES.filter((_, i) => (mask & (1 << i)) !== 0);
        messages.push(childSafetyMessage(set, band));
      }
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          messages,
          hold: FAMILY_HOLD_CATEGORIES,
          resources: SAFETY_RESOURCES_US,
          max: CHILD_SAFETY_MESSAGE_MAX_LENGTH,
        }),
      )
      .digest('hex');
    // A new version adds a line here (never edit an existing one) and needs a new approval.
    const PINNED: Readonly<Record<string, string>> = {
      'safety-templates.v2': '5b6d311e294e09e3053f426a3de90173fd5f8ee8b49989914d96bdbd39bf17d1',
      // v3: the child messages are the same as v2; the parent wording changed (API test pin).
      'safety-templates.v3': '5b6d311e294e09e3053f426a3de90173fd5f8ee8b49989914d96bdbd39bf17d1',
      // v4 (owner decision, 2026-09-25): the child messages are the same as v3; the hold list is
      // empty (no flag is held from the family) and the parent wording changed (email, actions).
      'safety-templates.v4': 'c18b6f3df516e3f58ea6eb3208a740348286ad1dba40bbc3925853bd30f68c33',
    };
    expect({ version: SAFETY_TEMPLATES_VERSION, digest }).toEqual({
      version: SAFETY_TEMPLATES_VERSION,
      digest: PINNED[SAFETY_TEMPLATES_VERSION],
    });
  });
});

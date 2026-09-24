import { describe, expect, it } from 'vitest';
import type { GuardiansOverview } from '@pencillift/contracts';
import { guardianSummary, maskInvitationEmail } from './guardians.ts';

const OWNER = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const GUARDIAN = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const AT = '2026-09-24T15:00:00.000Z';

describe('invitation email masking', () => {
  it('keeps the first and last character of the local part and the domain', () => {
    expect(maskInvitationEmail('sam.guardian@example.test')).toBe('s***n@example.test');
    expect(maskInvitationEmail('  Sam.Guardian@Example.TEST ')).toBe('s***n@example.test');
  });

  it('never reveals short local parts or malformed input', () => {
    expect(maskInvitationEmail('ab@example.test')).toBe('a***@example.test');
    expect(maskInvitationEmail('a@example.test')).toBe('a***@example.test');
    expect(maskInvitationEmail('not-an-email')).toBe('***');
    expect(maskInvitationEmail('@example.test')).toBe('***');
  });
});

describe('guardian summary', () => {
  const owner: GuardiansOverview = {
    callerRole: 'owner',
    maxAdults: 2,
    members: [
      {
        userId: OWNER,
        role: 'owner',
        email: 'riley.parent@example.test',
        isYou: true,
        acceptedAt: AT,
      },
    ],
    pendingInvitations: [
      {
        id: '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60',
        email: 'sam.guardian@example.test',
        expiresAt: AT,
        createdAt: AT,
      },
    ],
  };

  it('spells out roles and masks pending addresses on a shared device', () => {
    const summary = guardianSummary(owner);
    expect(summary.lines.map((l) => l.text)).toEqual(['Owner: You', 'Invited: s***n@example.test']);
    expect(summary.note).toMatch(/invite one guardian/);
  });

  it('tells a guardian that only the owner manages adults', () => {
    const summary = guardianSummary({
      callerRole: 'guardian',
      maxAdults: 2,
      members: [
        { userId: OWNER, role: 'owner', email: 'r***t@example.test', isYou: false, acceptedAt: AT },
        {
          userId: GUARDIAN,
          role: 'guardian',
          email: 'sam.guardian@example.test',
          isYou: true,
          acceptedAt: AT,
        },
      ],
      pendingInvitations: [],
    });
    expect(summary.lines.map((l) => l.text)).toEqual([
      'Owner: r***t@example.test',
      'Guardian: You',
    ]);
    expect(summary.note).toBe('Only the family owner can invite or remove guardians.');
  });

  it('says when the family is full', () => {
    const summary = guardianSummary({
      ...owner,
      members: [
        ...owner.members,
        {
          userId: GUARDIAN,
          role: 'guardian',
          email: 's***n@example.test',
          isYou: false,
          acceptedAt: AT,
        },
      ],
      pendingInvitations: [],
    });
    expect(summary.note).toBe('Your family has the maximum of 2 adults.');
  });
});

import { maskEmail, type GuardiansOverview } from '@pencillift/contracts';

/**
 * Guardian summary for the parent home screen (spec P1: two adults, owner removal). The API already
 * masks the other adult's address; `maskInvitationEmail` masks any address this app displays that
 * did not come pre-masked (e.g. an address typed for an invitation, echoed in a confirmation).
 * Pure: no react-native imports.
 */

/** Trims, lowercases and masks an address: `Sam.Guardian@Example.test` -> `s***n@example.test`. */
export function maskInvitationEmail(email: string): string {
  return maskEmail(email.trim().toLowerCase());
}

export interface GuardianLine {
  readonly key: string;
  readonly text: string;
}

export interface GuardianSummary {
  readonly lines: readonly GuardianLine[];
  readonly note: string;
}

/** One line per adult (role spelled out, never colour alone) plus what the caller can do. */
export function guardianSummary(overview: GuardiansOverview): GuardianSummary {
  const lines = overview.members.map((m) => {
    const role = m.role === 'owner' ? 'Owner' : 'Guardian';
    const who = m.isYou ? 'You' : (m.email ?? 'Email not available');
    return { key: m.userId, text: `${role}: ${who}` };
  });
  for (const invitation of overview.pendingInvitations) {
    lines.push({
      key: invitation.id,
      text: `Invited: ${overview.callerRole === 'owner' ? maskInvitationEmail(invitation.email) : invitation.email}`,
    });
  }
  const note =
    overview.callerRole === 'owner'
      ? overview.members.length >= overview.maxAdults
        ? `Your family has the maximum of ${overview.maxAdults} adults.`
        : 'You can invite one guardian from the parent portal.'
      : 'Only the family owner can invite or remove guardians.';
  return { lines, note };
}

import { err, ok, type Result } from '@pencillift/domain';

/**
 * Child-data AI gate (spec P4, AC_ACCESS_03). OpenAI requires approved zero data retention before
 * processing personal data of under-13 users; `store: false` alone is not ZDR. An environment boolean
 * is an operational switch, not evidence, so the gate requires a documented approval reference with a
 * verification date and fails closed on anything else.
 */

export interface ZdrEvidence {
  readonly reference: string;
  /** ISO date the owner verified the approval against the OpenAI organization/project. */
  readonly verifiedAt: string;
}

export type AgeBand = '5-7' | '8-10' | '11-13' | '14-18';

export type ChildDataGateCode =
  'ZDR_EVIDENCE_REQUIRED' | 'ZDR_EVIDENCE_INVALID' | 'MOCK_PROVIDER_IN_PRODUCTION';

export interface ChildDataGateInput {
  readonly containsChildPersonalData: boolean;
  /** Conservative: every band that can include a 12-year-old counts as under 13. */
  readonly ageBand: AgeBand | null;
  readonly zdrEvidence: ZdrEvidence | null;
  readonly environment: 'development' | 'test' | 'staging' | 'production';
  readonly providerIsMock: boolean;
  readonly now: Date;
}

/** Values that look like switches, not evidence (an env boolean is never ZDR approval). */
const PLACEHOLDER_REFERENCES = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'enabled',
  'approved',
  'granted',
  'pending',
  'unknown',
  'n/a',
  'tbd',
  'todo',
  'placeholder',
]);

export function mayIncludeUnder13(ageBand: AgeBand | null): boolean {
  return ageBand !== '14-18';
}

export function checkChildDataGate(
  input: ChildDataGateInput,
): Result<{ readonly zdrReference: string | null }, ChildDataGateCode> {
  if (input.environment === 'production' && input.providerIsMock) {
    return err('MOCK_PROVIDER_IN_PRODUCTION', 'Production cannot use a mock AI provider');
  }
  if (!input.containsChildPersonalData) return ok({ zdrReference: null });
  // Mock providers never send data anywhere; development/test may exercise flows without ZDR.
  if (input.providerIsMock && input.environment !== 'production') return ok({ zdrReference: null });
  const evidence = input.zdrEvidence;
  if (evidence === null) {
    return mayIncludeUnder13(input.ageBand)
      ? err(
          'ZDR_EVIDENCE_REQUIRED',
          'Child personal data needs documented zero-data-retention approval',
        )
      : err(
          'ZDR_EVIDENCE_REQUIRED',
          'Personal data of minors needs documented zero-data-retention approval',
        );
  }
  const verified = Date.parse(evidence.verifiedAt);
  const reference = evidence.reference.trim();
  if (
    reference.length < 6 ||
    PLACEHOLDER_REFERENCES.has(reference.toLowerCase()) ||
    Number.isNaN(verified) ||
    verified > input.now.getTime()
  ) {
    return err(
      'ZDR_EVIDENCE_INVALID',
      'The zero-data-retention evidence is incomplete or dated in the future',
    );
  }
  return ok({ zdrReference: evidence.reference });
}

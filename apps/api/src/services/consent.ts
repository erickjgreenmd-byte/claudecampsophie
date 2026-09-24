import type { Tx } from '../db.ts';

/**
 * Child-data processing gate (spec P3/P4, AC_ACCESS_01/02/10). Returns true only when the family has a
 * verified, non-withdrawn consent record. Records from a test/mock provider count only outside
 * production, so a development consent can never enable production child-data processing.
 */
export async function hasVerifiedConsent(
  tx: Tx,
  familyId: string,
  options: { allowTestProvider: boolean },
): Promise<boolean> {
  const rows = await tx<{ status: string; is_test_provider: boolean }[]>`
    select status, is_test_provider from public.consent_records
     where family_id = ${familyId}
     order by created_at desc
     limit 1
  `;
  const latest = rows[0];
  if (!latest || latest.status !== 'verified') return false;
  return options.allowTestProvider || !latest.is_test_provider;
}

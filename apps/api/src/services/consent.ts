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

/**
 * Whether the family's consent state still allows the child's own traffic: pairing a device,
 * refreshing a child session and generating practice from the child's evidence (CS-R1-01).
 *
 * Activation is the gate that requires a VERIFIED record before a child becomes active
 * (routes/family.ts), and consent records are never deleted (withdrawal keeps the row), so a
 * family with an active child always has a latest record in production. This check therefore
 * asks a narrower question than `hasVerifiedConsent`: once a record exists, only a verified one
 * (test providers counted as there) keeps the child working; a withdrawn, failed, expired or
 * pending record, including a restart that is still pending after a withdrawal, blocks it. A
 * family with no record at all is not blocked here, because that is the state of fixtures that
 * activate a child directly in SQL, never of a production family.
 */
export async function consentAllowsChildAccess(
  tx: Tx,
  familyId: string,
  options: { allowTestProvider: boolean },
): Promise<boolean> {
  const rows = await tx<{ status: string; is_test_provider: boolean }[]>`
    select status, is_test_provider from public.consent_records
     where family_id = ${familyId}
     order by created_at desc, id desc
     limit 1
  `;
  const latest = rows[0];
  if (!latest) return true;
  if (latest.status !== 'verified') return false;
  return options.allowTestProvider || !latest.is_test_provider;
}

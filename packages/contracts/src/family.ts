import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from './common.ts';

/**
 * Family vertical contracts (spec P1 guardians, P3 identity/consent/authorization, P14 parent
 * screens): family overview, child profiles, paired devices, guardians/invitations and consent.
 * Every response schema is strict so a server change that adds a private field fails loudly.
 */

// ---------------------------------------------------------------------------------------------
// Family and child profiles
// ---------------------------------------------------------------------------------------------

/** draft: no paid slot, no charge, no premium access; active: holds a paid slot; archived: history. */
export const CHILD_PROFILE_STATUSES = ['draft', 'active', 'archived'] as const;
export const childProfileStatusSchema = z.enum(CHILD_PROFILE_STATUSES);
export type ChildProfileStatus = z.infer<typeof childProfileStatusSchema>;

export const AGE_BANDS = ['5-7', '8-10', '11-13', '14-18'] as const;
export const ageBandSchema = z.enum(AGE_BANDS);
export type AgeBand = z.infer<typeof ageBandSchema>;

/** 0 = kindergarten. Launch scope is K-8; the API accepts up to 12 for later expansion. */
export const gradeLevelSchema = z.number().int().min(0).max(12);

export const createFamilyRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(64),
});
export type CreateFamilyRequest = z.infer<typeof createFamilyRequestSchema>;

export const createFamilyResponseSchema = z.strictObject({ familyId: uuidSchema });

export const familyChildSchema = z.strictObject({
  id: uuidSchema,
  nickname: z.string(),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
  status: childProfileStatusSchema,
});
export type FamilyChild = z.infer<typeof familyChildSchema>;

/** GET /v1/family */
export const familyOverviewResponseSchema = z.strictObject({
  id: uuidSchema,
  displayName: z.string(),
  timezone: z.string(),
  paidSlots: z.number().int().min(0),
  billingConflict: z.string().nullable(),
  managingChannel: z.string().nullable(),
  children: z.array(familyChildSchema),
});
export type FamilyOverview = z.infer<typeof familyOverviewResponseSchema>;

/** POST /v1/children (parent + step-up). Always creates an uncharged draft. */
export const createChildProfileRequestSchema = z.strictObject({
  nickname: z.string().trim().min(1).max(40),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
});
export type CreateChildProfileRequest = z.infer<typeof createChildProfileRequestSchema>;

export const createChildProfileResponseSchema = z.strictObject({
  childId: uuidSchema,
  status: z.literal('draft'),
});

/** GET /v1/child/me — the paired child's own safe fields only. */
export const childMeResponseSchema = z.strictObject({
  id: uuidSchema,
  nickname: z.string(),
  gradeLevel: gradeLevelSchema,
  ageBand: ageBandSchema,
});
export type ChildMe = z.infer<typeof childMeResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

export const devicePlatformSchema = z.enum(['ios', 'android', 'web']);

export const childDeviceSchema = z.strictObject({
  id: uuidSchema,
  childId: uuidSchema,
  label: z.string(),
  platform: devicePlatformSchema,
  pairedAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
});
export type ChildDevice = z.infer<typeof childDeviceSchema>;

/** GET /v1/devices */
export const childDevicesResponseSchema = z.strictObject({ devices: z.array(childDeviceSchema) });
export type ChildDevices = z.infer<typeof childDevicesResponseSchema>;

/** `{ ok: true }` acknowledgement used by revoke/lock/remove endpoints. */
export const familyOkResponseSchema = z.strictObject({ ok: z.literal(true) });

// ---------------------------------------------------------------------------------------------
// Guardians and invitations (spec P1: two adults, verified acceptance, owner removal)
// ---------------------------------------------------------------------------------------------

/** Spec P1: the owner plus one invited guardian. The DB trigger enforces the same limit. */
export const MAX_FAMILY_ADULTS = 2;
export const GUARDIAN_INVITATION_TTL_DAYS = 7;

export const adultRoleSchema = z.enum(['owner', 'guardian']);
export type AdultRole = z.infer<typeof adultRoleSchema>;

export const guardianInvitationRequestSchema = z.strictObject({
  email: z.email().max(254),
});
export type GuardianInvitationRequest = z.infer<typeof guardianInvitationRequestSchema>;

/** The invitation token is never returned: it travels only inside the emailed link. */
export const guardianInvitationResponseSchema = z.strictObject({
  invitationId: uuidSchema,
  email: z.string(),
  status: z.literal('pending'),
  expiresAt: isoDateTimeSchema,
});
export type GuardianInvitationResponse = z.infer<typeof guardianInvitationResponseSchema>;

export const guardianMemberSchema = z.strictObject({
  userId: uuidSchema,
  role: adultRoleSchema,
  /** The caller's own address in full; the other adult's address masked. Null when unknown. */
  email: z.string().nullable(),
  isYou: z.boolean(),
  acceptedAt: isoDateTimeSchema,
});
export type GuardianMember = z.infer<typeof guardianMemberSchema>;

export const pendingInvitationSchema = z.strictObject({
  id: uuidSchema,
  /** Full for the family owner who sent it; masked for anyone else. */
  email: z.string(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;

/** GET /v1/guardians */
export const guardiansResponseSchema = z.strictObject({
  callerRole: adultRoleSchema,
  maxAdults: z.number().int().min(1),
  members: z.array(guardianMemberSchema),
  pendingInvitations: z.array(pendingInvitationSchema),
});
export type GuardiansOverview = z.infer<typeof guardiansResponseSchema>;

export const acceptInvitationRequestSchema = z.strictObject({
  token: z
    .string()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const acceptInvitationResponseSchema = z.strictObject({
  familyId: uuidSchema,
  role: z.literal('guardian'),
});

/** Stable BUSINESS_RULE / CONFLICT rule codes the guardian screens branch on. */
export const GUARDIAN_RULES = {
  adultLimitReached: 'ADULT_LIMIT_REACHED',
  invitationAlreadyPending: 'INVITATION_ALREADY_PENDING',
  invitationNotPending: 'INVITATION_NOT_PENDING',
  invitationExpired: 'INVITATION_EXPIRED',
  invitationEmailMismatch: 'INVITATION_EMAIL_MISMATCH',
  emailNotVerified: 'EMAIL_NOT_VERIFIED',
  alreadyInFamily: 'ALREADY_IN_FAMILY',
  cannotRemoveOwner: 'CANNOT_REMOVE_OWNER',
  ownerOnly: 'OWNER_ONLY',
} as const;

/**
 * Masks an email address for display to the other adult: first (and last) character of the local
 * part plus the domain, e.g. `s***m@example.test`. Anything that is not an address becomes `***`.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length <= 2 ? `${local[0] ?? ''}***` : `${local[0] ?? ''}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

// ---------------------------------------------------------------------------------------------
// Consent (spec P3: verifiable parental consent behind a provider adapter)
// ---------------------------------------------------------------------------------------------

/** Version of the consent notice the parent agrees to; bump when the notice text changes. */
export const CONSENT_POLICY_VERSION = '2026-09-v1';
export const CONSENT_PURPOSE = 'child_learning_data';

export const CONSENT_STATES = ['none', 'pending', 'verified', 'failed', 'withdrawn'] as const;
export const consentStateSchema = z.enum(CONSENT_STATES);
export type ConsentState = z.infer<typeof consentStateSchema>;

/** GET /v1/consent and POST /v1/consent/:id/refresh */
export const consentStatusResponseSchema = z.strictObject({
  state: consentStateSchema,
  /** The latest consent record, or null when none exists. */
  consentId: uuidSchema.nullable(),
  /** True when the latest record came from a development/test provider (never real consent). */
  isTestProvider: z.boolean(),
  /** True when this environment's configured consent provider is a development/test double. */
  configuredProviderIsTest: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
  withdrawnAt: isoDateTimeSchema.nullable(),
  policyVersion: z.string().nullable(),
  currentPolicyVersion: z.string(),
});
export type ConsentStatus = z.infer<typeof consentStatusResponseSchema>;

/** POST /v1/consent/start takes an empty object: nothing from the client can set the outcome. */
export const consentStartRequestSchema = z.strictObject({});

export const consentStartResponseSchema = z.strictObject({
  consentId: uuidSchema,
  state: z.literal('pending'),
  /** Where the parent completes verification with the provider (null when none is needed). */
  redirectUrl: z.url().nullable(),
  isTestProvider: z.boolean(),
});
export type ConsentStartResponse = z.infer<typeof consentStartResponseSchema>;

export const consentWithdrawResponseSchema = z.strictObject({
  state: z.literal('withdrawn'),
  cancelledJobs: z.number().int().min(0),
});

export const CONSENT_RULES = {
  alreadyVerified: 'CONSENT_ALREADY_VERIFIED',
  alreadyWithdrawn: 'CONSENT_ALREADY_WITHDRAWN',
  providerChanged: 'CONSENT_PROVIDER_CHANGED',
} as const;

// ---------------------------------------------------------------------------------------------
// Parent PIN feedback (the API's isWeakPin stays authoritative)
// ---------------------------------------------------------------------------------------------

/**
 * Client-side mirror of the API's weak-PIN rule so parents get feedback before submitting.
 * Returns a reason string, or null when the PIN looks acceptable. The server still decides.
 */
export function weakParentPinReason(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'Use exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin)) return 'Avoid repeating one digit.';
  if ('0123456789012345'.includes(pin) || '9876543210987654'.includes(pin))
    return 'Avoid counting up or down.';
  if (['123123', '121212', '112233'].includes(pin)) return 'Avoid simple patterns.';
  return null;
}

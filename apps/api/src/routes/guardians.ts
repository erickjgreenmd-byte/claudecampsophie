import { Hono, type Context } from 'hono';
import {
  acceptInvitationRequestSchema,
  CONSENT_POLICY_VERSION,
  CONSENT_PURPOSE,
  CONSENT_RULES,
  consentStartRequestSchema,
  GUARDIAN_INVITATION_TTL_DAYS,
  GUARDIAN_RULES,
  guardianInvitationRequestSchema,
  MAX_FAMILY_ADULTS,
  maskEmail,
  uuidSchema,
  type ConsentState,
  type ConsentStatus,
} from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { MOCK_ENVIRONMENTS } from '../config.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule, isUniqueViolation, pgErrorCode } from '../errors.ts';
import { assertRecentUnlock, requireParent } from '../middleware/auth.ts';
import type { AppDeps, AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, type RateRule } from '../middleware/rate-limit.ts';
import { randomToken, sha256Hex } from '../security/crypto.ts';

/**
 * Guardians, invitations and verifiable parental consent (spec P1 guardians paragraph, P3;
 * AC_ACCESS_01, 02, 09). Paths: /v1/guardians*, /v1/invitations*, /v1/consent*.
 *
 * Reads that a family member may make run as the caller (`asParent`) so RLS is a second layer.
 * Writes to tables adults cannot write directly (memberships, invitations, consent records, jobs)
 * run as the service role, and every such statement is scoped to the caller's family explicitly.
 */

const DAY_MS = 86_400_000;

/** Local rate rules for this vertical (reviewed here; shared rules live in rate-limit.ts). */
const RULES = {
  invitePerFamily: { limit: 20, windowSeconds: 24 * 3600 },
  acceptPerUser: { limit: 10, windowSeconds: 3600 },
  consentStartPerFamily: { limit: 10, windowSeconds: 3600 },
  consentRefreshPerFamily: { limit: 60, windowSeconds: 3600 },
} as const satisfies Record<string, RateRule>;

/**
 * Decision: consent withdrawal cancels every queued/failed_retryable job for the family EXCEPT
 * jobs that protect privacy or keep billing records correct. Deletion/retention purges must still
 * run (cancelling them would keep child data longer), a parent's export is their own data, and
 * billing/promotion reconciliation must finish so provider state never goes unreconciled. Using a
 * keep-list (not a cancel-list) means any new child-data job kind is cancelled by default.
 *
 * `safety_flag_email` stays too (CS-R1-02): the owner decision of 2026-09-25 is that every safety
 * flag reaches the parent, the job's payload is the report id only (no child data), and the email
 * tells the parent about a flag already filed rather than processing anything new. Cancelling it
 * would leave the report 'not_sent' forever, because a cancelled job never dead-letters.
 */
const JOBS_KEPT_ON_CONSENT_WITHDRAWAL = [
  'deletion_purge',
  'retention_purge',
  'export_build',
  'entitlement_reconcile',
  'promo_month_generate',
  'promo_offer_provision',
  'promo_reconcile',
  'donation_accrue',
  'payout_prepare',
  'safety_flag_email',
] as const;

interface Membership {
  familyId: string;
  role: 'owner' | 'guardian';
}

/** The caller's active membership (RLS: only visible to an active member of a live family). */
async function callerMembership(c: Context<AppEnv>): Promise<Membership> {
  const { deps, parent } = c.var;
  const [row] = await deps.db.asParent(
    parent,
    (tx) => tx<{ family_id: string; role: 'owner' | 'guardian' }[]>`
      select family_id, role from public.family_memberships
       where user_id = ${parent.userId} and status = 'active'`,
  );
  if (!row) throw new ApiError('NOT_FOUND', 'Create your family first');
  return { familyId: row.family_id, role: row.role };
}

function assertOwner(membership: Membership): void {
  if (membership.role !== 'owner') {
    throw new ApiError('FORBIDDEN', 'Only the family owner can change guardians', {
      rule: GUARDIAN_RULES.ownerOnly,
    });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Verified email of an adult. Supabase does not grant the service role SELECT on auth.users, so
 * this goes through `app.adult_auth_email` (schema request SR-FAMILY-1). Fails closed when the
 * function is not deployed yet: acceptance is then honestly "not available", never skipped.
 */
async function adultEmail(
  tx: Tx,
  userId: string,
): Promise<{ email: string | null; verified: boolean }> {
  try {
    const [row] = await tx<{ email: string | null; email_verified: boolean }[]>`
      select email, email_verified from app.adult_auth_email(${userId})`;
    return {
      email: row?.email ? normalizeEmail(row.email) : null,
      verified: row?.email_verified ?? false,
    };
  } catch (error) {
    if (pgErrorCode(error) === '42883') {
      throw new ApiError('NOT_CONFIGURED', 'Guardian invitations are not available yet');
    }
    throw error;
  }
}

/** Unique index requested from the migration owner (see the accept route). */
const ONE_FAMILY_PER_ADULT_INDEX = 'family_memberships_one_active_family_per_user';

function isAdultLimitError(error: unknown): boolean {
  return (
    pgErrorCode(error) === 'P0001' &&
    error instanceof Error &&
    error.message.includes('maximum of 2 active adults')
  );
}

function adultLimitReached(): ApiError {
  return new ApiError('CONFLICT', 'This family already has two adults', {
    rule: GUARDIAN_RULES.adultLimitReached,
  });
}

/**
 * Decision: the accept link points at the web portal's guardian page, whose origin is the first
 * configured CORS origin (the only portal origin the API already trusts). The token travels in the
 * URL fragment, which browsers never send to servers, proxies or Referer headers.
 */
function acceptUrl(deps: AppDeps, token: string): string {
  const origin = deps.config.corsOrigins[0];
  if (!origin) throw new ApiError('NOT_CONFIGURED', 'Guardian invitations are not available yet');
  return `${origin}/app/guardians#accept=${token}`;
}

async function insertAudit(
  tx: Tx,
  event: {
    familyId: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, string | number | boolean>;
  },
): Promise<void> {
  await tx`
    insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (${event.familyId}, ${event.actorUserId}, 'parent', ${event.action}, ${event.targetType},
            ${event.targetId}, ${tx.json(event.metadata ?? {})})`;
}

// ---------------------------------------------------------------------------------------------
// Consent helpers
// ---------------------------------------------------------------------------------------------

interface ConsentRow {
  id: string;
  status: Exclude<ConsentState, 'none'>;
  is_test_provider: boolean;
  verified_at: Date | null;
  withdrawn_at: Date | null;
  policy_version: string;
}

function consentView(row: ConsentRow | undefined, deps: AppDeps): ConsentStatus {
  return {
    state: row?.status ?? 'none',
    consentId: row?.id ?? null,
    isTestProvider: row?.is_test_provider ?? false,
    configuredProviderIsTest: deps.providers.consent.isMock,
    verifiedAt: row?.verified_at?.toISOString() ?? null,
    withdrawnAt: row?.withdrawn_at?.toISOString() ?? null,
    policyVersion: row?.policy_version ?? null,
    currentPolicyVersion: CONSENT_POLICY_VERSION,
  };
}

async function latestConsent(
  c: Context<AppEnv>,
  familyId: string,
): Promise<ConsentRow | undefined> {
  const { deps, parent } = c.var;
  const [row] = await deps.db.asParent(
    parent,
    (tx) => tx<ConsentRow[]>`
      select id, status, is_test_provider, verified_at, withdrawn_at, policy_version
        from public.consent_records where family_id = ${familyId}
       order by created_at desc, id desc limit 1`,
  );
  return row;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function guardiansRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/guardians', requireParent);
  r.use('/guardians/*', requireParent);
  r.use('/invitations/*', requireParent);
  r.use('/consent', requireParent);
  r.use('/consent/*', requireParent);

  // --- Guardians ------------------------------------------------------------------------------

  r.get('/guardians', async (c) => {
    const { deps, parent } = c.var;
    const membership = await callerMembership(c);
    const now = deps.clock();
    const data = await deps.db.asParent(parent, async (tx) => ({
      members: await tx<{ user_id: string; role: 'owner' | 'guardian'; accepted_at: Date }[]>`
        select user_id, role, accepted_at from public.family_memberships
         where family_id = ${membership.familyId} and status = 'active'
         order by (role = 'owner') desc, accepted_at`,
      invitations: await tx<{ id: string; email: string; expires_at: Date; created_at: Date }[]>`
        select id, email::text as email, expires_at, created_at from public.guardian_invitations
         where family_id = ${membership.familyId} and status = 'pending' and expires_at > ${now}
         order by created_at`,
    }));
    // Emails come from the auth service; the user ids were read under RLS for this family only.
    // Without the lookup function (schema request pending) the list still works, minus addresses.
    let emails = new Map<string, string | null>();
    try {
      emails = await deps.db.asService(async (tx) => {
        const found = new Map<string, string | null>();
        for (const m of data.members) found.set(m.user_id, (await adultEmail(tx, m.user_id)).email);
        return found;
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'NOT_CONFIGURED')) throw error;
    }
    return c.json({
      callerRole: membership.role,
      maxAdults: MAX_FAMILY_ADULTS,
      members: data.members.map((m) => {
        const isYou = m.user_id === parent.userId;
        const email = emails.get(m.user_id) ?? null;
        return {
          userId: m.user_id,
          role: m.role,
          email: email === null ? null : isYou ? email : maskEmail(email),
          isYou,
          acceptedAt: m.accepted_at.toISOString(),
        };
      }),
      // Decision: only the owner (who typed the address) sees pending addresses in full.
      pendingInvitations: data.invitations.map((i) => ({
        id: i.id,
        email: membership.role === 'owner' ? i.email : maskEmail(i.email),
        expiresAt: i.expires_at.toISOString(),
        createdAt: i.created_at.toISOString(),
      })),
    });
  });

  r.post('/guardians/invitations', async (c) => {
    const { deps, parent } = c.var;
    const membership = await callerMembership(c);
    assertOwner(membership);
    await assertRecentUnlock(c);
    const body = await readJson(c, guardianInvitationRequestSchema);
    const email = normalizeEmail(body.email);
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `guardian-invite:${membership.familyId}`,
      RULES.invitePerFamily,
      now,
    );
    const token = randomToken();
    const link = acceptUrl(deps, token);
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(now.getTime() + GUARDIAN_INVITATION_TTL_DAYS * DAY_MS);

    const result = await deps.db.asService(async (tx) => {
      // Serialize invitation changes per family; a tombstoned family cannot invite.
      const [family] = await tx<{ display_name: string }[]>`
        select display_name from public.families
         where id = ${membership.familyId} and deleted_at is null for update`;
      if (!family) throw new ApiError('NOT_FOUND', 'Create your family first');
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.family_memberships
         where family_id = ${membership.familyId} and status = 'active'`;
      if ((count?.n ?? 0) >= MAX_FAMILY_ADULTS) throw adultLimitReached();
      const own = await adultEmail(tx, parent.userId);
      if (own.email === email) {
        throw new ApiError('VALIDATION_FAILED', 'You are already a member of this family');
      }
      // A pending invitation past its expiry no longer blocks a fresh one to the same address.
      await tx`
        update public.guardian_invitations set status = 'expired'
         where family_id = ${membership.familyId} and email = ${email}
           and status = 'pending' and expires_at <= ${now}`;
      const [pending] = await tx<{ id: string }[]>`
        select id from public.guardian_invitations
         where family_id = ${membership.familyId} and email = ${email} and status = 'pending'`;
      if (pending) {
        throw new ApiError('CONFLICT', 'An invitation to this address is already pending', {
          rule: GUARDIAN_RULES.invitationAlreadyPending,
        });
      }
      const [invitation] = await tx<{ id: string }[]>`
        insert into public.guardian_invitations (family_id, email, invited_by, expires_at, created_at)
        values (${membership.familyId}, ${email}, ${parent.userId}, ${expiresAt}, ${now})
        returning id`;
      const invitationId = invitation!.id;
      // Only the SHA-256 of the 256-bit token is stored; the raw token exists only in the email.
      await tx`
        insert into private.guardian_invitation_tokens (invitation_id, token_hash, created_at)
        values (${invitationId}, decode(${tokenHash}, 'hex'), ${now})`;
      await insertAudit(tx, {
        familyId: membership.familyId,
        actorUserId: parent.userId,
        action: 'guardian.invited',
        targetType: 'guardian_invitation',
        targetId: invitationId,
      });
      // Sent inside the transaction: if the provider fails, no unusable pending invitation remains.
      try {
        await deps.providers.email.send({
          to: email,
          templateKey: 'guardian_invitation',
          params: {
            acceptUrl: link,
            familyName: family.display_name,
            expiresAt: expiresAt.toISOString(),
          },
        });
      } catch {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          'We could not send the invitation email. Please try again later.',
        );
      }
      return invitationId;
    });

    return c.json(
      { invitationId: result, email, status: 'pending', expiresAt: expiresAt.toISOString() },
      201,
    );
  });

  r.post('/guardians/invitations/:invitationId/revoke', async (c) => {
    const { deps, parent } = c.var;
    const invitationId = uuidSchema.safeParse(c.req.param('invitationId'));
    if (!invitationId.success) throw new ApiError('NOT_FOUND', 'Invitation not found');
    const membership = await callerMembership(c);
    assertOwner(membership);
    await assertRecentUnlock(c);
    const revoked = await deps.db.asService(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update public.guardian_invitations set status = 'revoked'
         where id = ${invitationId.data} and family_id = ${membership.familyId} and status = 'pending'
        returning id`;
      if (rows.length === 0) return false;
      await insertAudit(tx, {
        familyId: membership.familyId,
        actorUserId: parent.userId,
        action: 'guardian.invitation_revoked',
        targetType: 'guardian_invitation',
        targetId: invitationId.data,
      });
      return true;
    });
    if (!revoked) throw new ApiError('NOT_FOUND', 'Invitation not found');
    return c.json({ ok: true });
  });

  r.delete('/guardians/:userId', async (c) => {
    const { deps, parent } = c.var;
    const target = uuidSchema.safeParse(c.req.param('userId'));
    if (!target.success) throw new ApiError('NOT_FOUND', 'Guardian not found');
    const membership = await callerMembership(c);
    assertOwner(membership);
    await assertRecentUnlock(c);
    if (target.data === parent.userId) {
      throw businessRule(GUARDIAN_RULES.cannotRemoveOwner, 'The family owner cannot be removed');
    }
    const now = deps.clock();
    const removed = await deps.db.asService(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update public.family_memberships
           set status = 'revoked', revoked_at = ${now}, revoked_by = ${parent.userId}
         where family_id = ${membership.familyId} and user_id = ${target.data}
           and role = 'guardian' and status = 'active'
        returning id`;
      if (rows.length === 0) return false;
      // Pending privileged actions die with the membership (AC_ACCESS_09): step-up unlocks on
      // every session, unredeemed device pairing codes they created (a code would otherwise still
      // mint a 30-day child session), invitations they sent, and consent they started but never
      // completed. Marking a code consumed is how every other path retires one (family.ts).
      await tx`
        update private.adult_unlocks set revoked_at = ${now}
         where user_id = ${target.data} and revoked_at is null`;
      await tx`
        update private.child_pairing_codes set consumed_at = ${now}
         where family_id = ${membership.familyId} and created_by = ${target.data}
           and consumed_at is null`;
      await tx`
        update public.guardian_invitations set status = 'revoked'
         where family_id = ${membership.familyId} and invited_by = ${target.data} and status = 'pending'`;
      await tx`
        update public.consent_records set status = 'withdrawn', withdrawn_at = ${now}
         where family_id = ${membership.familyId} and adult_user_id = ${target.data} and status = 'pending'`;
      await insertAudit(tx, {
        familyId: membership.familyId,
        actorUserId: parent.userId,
        action: 'guardian.removed',
        targetType: 'user',
        targetId: target.data,
      });
      return true;
    });
    if (!removed) throw new ApiError('NOT_FOUND', 'Guardian not found');
    return c.json({ ok: true });
  });

  // --- Invitation acceptance (any signed-in adult; no family yet) -----------------------------

  r.post('/invitations/accept', async (c) => {
    const { deps, parent } = c.var;
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `invite-accept:${parent.userId}`,
      RULES.acceptPerUser,
      now,
    );
    const { token } = await readJson(c, acceptInvitationRequestSchema);
    const tokenHash = await sha256Hex(token);

    type Outcome =
      | { kind: 'accepted'; familyId: string }
      | { kind: 'expired' }
      | { kind: 'error'; error: ApiError };
    let outcome: Outcome;
    try {
      outcome = await deps.db.asService(async (tx): Promise<Outcome> => {
        // One family per adult (spec P1). The adult-limit trigger locks only the *invited* family,
        // so two acceptances into different families would both pass the membership check below.
        // This per-adult transaction lock, taken first so lock order is always adult → invitation
        // → family, makes the second acceptance wait and then see the first one's membership.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`adult-membership:${parent.userId}`}, 0))`;
        const [invitation] = await tx<
          { id: string; family_id: string; email: string; status: string; expires_at: Date }[]
        >`
          select i.id, i.family_id, i.email::text as email, i.status, i.expires_at
            from private.guardian_invitation_tokens t
            join public.guardian_invitations i on i.id = t.invitation_id
            join public.families f on f.id = i.family_id
           where t.token_hash = decode(${tokenHash}, 'hex') and f.deleted_at is null
           for update of i`;
        if (!invitation) {
          return {
            kind: 'error',
            error: new ApiError('NOT_FOUND', 'This invitation link is not valid'),
          };
        }
        if (invitation.status !== 'pending') {
          return {
            kind: 'error',
            error: new ApiError('CONFLICT', 'This invitation was already used or cancelled', {
              rule: GUARDIAN_RULES.invitationNotPending,
            }),
          };
        }
        if (invitation.expires_at <= now) {
          await tx`update public.guardian_invitations set status = 'expired' where id = ${invitation.id}`;
          return { kind: 'expired' };
        }
        const adult = await adultEmail(tx, parent.userId);
        if (!adult.verified || adult.email === null) {
          return {
            kind: 'error',
            error: new ApiError('FORBIDDEN', 'Verify your email address first', {
              rule: GUARDIAN_RULES.emailNotVerified,
            }),
          };
        }
        if (adult.email !== normalizeEmail(invitation.email)) {
          return {
            kind: 'error',
            error: new ApiError(
              'FORBIDDEN',
              'This invitation was sent to a different email address',
              { rule: GUARDIAN_RULES.invitationEmailMismatch },
            ),
          };
        }
        const existing = await tx`
          select 1 from public.family_memberships where user_id = ${parent.userId} and status = 'active'`;
        if (existing.length > 0) {
          return {
            kind: 'error',
            error: new ApiError('CONFLICT', 'You already belong to a family', {
              rule: GUARDIAN_RULES.alreadyInFamily,
            }),
          };
        }
        // The adult-limit trigger locks the family row and raises if two adults are already active.
        await tx`
          insert into public.family_memberships (family_id, user_id, role, invited_by, accepted_at, created_at)
          select ${invitation.family_id}, ${parent.userId}, 'guardian', invited_by, ${now}, ${now}
            from public.guardian_invitations where id = ${invitation.id}`;
        const updated = await tx`
          update public.guardian_invitations
             set status = 'accepted', accepted_by = ${parent.userId}, accepted_at = ${now}
           where id = ${invitation.id} and status = 'pending' returning id`;
        if (updated.length !== 1) throw new Error('invitation state changed during acceptance');
        await insertAudit(tx, {
          familyId: invitation.family_id,
          actorUserId: parent.userId,
          action: 'guardian.accepted',
          targetType: 'guardian_invitation',
          targetId: invitation.id,
        });
        return { kind: 'accepted', familyId: invitation.family_id };
      });
    } catch (error) {
      if (isAdultLimitError(error)) throw adultLimitReached();
      // Requested DB backstop (one active membership per adult, covering create_family(), which
      // cannot take the lock above): a concurrent family creation surfaces as this violation.
      if (isUniqueViolation(error, ONE_FAMILY_PER_ADULT_INDEX)) {
        throw new ApiError('CONFLICT', 'You already belong to a family', {
          rule: GUARDIAN_RULES.alreadyInFamily,
        });
      }
      throw error;
    }
    if (outcome.kind === 'error') throw outcome.error;
    if (outcome.kind === 'expired') {
      throw businessRule(
        GUARDIAN_RULES.invitationExpired,
        'This invitation has expired. Ask the family owner to send a new one.',
      );
    }
    return c.json({ familyId: outcome.familyId, role: 'guardian' });
  });

  // --- Consent --------------------------------------------------------------------------------

  r.get('/consent', async (c) => {
    const membership = await callerMembership(c);
    return c.json(consentView(await latestConsent(c, membership.familyId), c.var.deps));
  });

  r.post('/consent/start', async (c) => {
    const { deps, parent } = c.var;
    const membership = await callerMembership(c);
    await readJson(c, consentStartRequestSchema);
    const provider = deps.providers.consent;
    // Defense in depth: the Worker never wires a mock outside development/test (selectConsentProvider),
    // but a mock consent record is never written there either.
    if (provider.isMock && !MOCK_ENVIRONMENTS.has(deps.config.environment)) {
      throw new ApiError('NOT_CONFIGURED', 'Verifiable parental consent is not available yet');
    }
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `consent-start:${membership.familyId}`,
      RULES.consentStartPerFamily,
      now,
    );
    const latest = await latestConsent(c, membership.familyId);
    if (latest?.status === 'verified') {
      throw new ApiError('CONFLICT', 'Consent is already verified for this family', {
        rule: CONSENT_RULES.alreadyVerified,
      });
    }
    let started: Awaited<ReturnType<typeof provider.start>>;
    try {
      started = await provider.start({
        familyId: membership.familyId,
        adultUserId: parent.userId,
        policyVersion: CONSENT_POLICY_VERSION,
      });
    } catch {
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'The consent service is unavailable. Please try again later.',
      );
    }
    const consentId = await deps.db.asService(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.consent_records
          (family_id, adult_user_id, provider, provider_reference, method, purpose, policy_version,
           scope, status, is_test_provider)
        values (${membership.familyId}, ${parent.userId}, ${provider.name}, ${started.providerReference},
                'pending', ${CONSENT_PURPOSE}, ${CONSENT_POLICY_VERSION},
                ${tx.json({ purpose: CONSENT_PURPOSE })}, 'pending', ${provider.isMock})
        returning id`;
      await insertAudit(tx, {
        familyId: membership.familyId,
        actorUserId: parent.userId,
        action: 'consent.started',
        targetType: 'consent_record',
        targetId: row!.id,
        metadata: { testProvider: provider.isMock },
      });
      return row!.id;
    });
    return c.json(
      {
        consentId,
        state: 'pending',
        redirectUrl: started.redirectUrl,
        isTestProvider: provider.isMock,
      },
      201,
    );
  });

  r.post('/consent/withdraw', async (c) => {
    const { deps, parent } = c.var;
    const membership = await callerMembership(c);
    await assertRecentUnlock(c);
    await readJson(c, consentStartRequestSchema);
    const now = deps.clock();
    const outcome = await deps.db.asService(async (tx) => {
      const [latest] = await tx<{ id: string; status: string }[]>`
        select id, status from public.consent_records where family_id = ${membership.familyId}
         order by created_at desc, id desc limit 1 for update`;
      if (!latest) return { kind: 'none' as const };
      if (latest.status === 'withdrawn') return { kind: 'already' as const };
      const updated = await tx`
        update public.consent_records set status = 'withdrawn', withdrawn_at = ${now}
         where id = ${latest.id} and family_id = ${membership.familyId} and status <> 'withdrawn'
        returning id`;
      if (updated.length !== 1) throw new Error('consent state changed during withdrawal');
      const cancelled = await tx<{ id: string }[]>`
        update public.jobs set status = 'cancelled', last_error_code = 'consent_withdrawn'
         where family_id = ${membership.familyId}
           and status in ('queued', 'failed_retryable')
           and kind <> all(${JOBS_KEPT_ON_CONSENT_WITHDRAWAL})
        returning id`;
      // Withdrawal stops the children's own traffic, not only server-side processing (CS-R1-01):
      // the same statements as archiving (routes/family.ts) sign every paired device out, and
      // unredeemed pairing codes stop working. Profiles keep their status and paid slots (releasing
      // a slot is a billing decision); pairing, refresh and practice generation re-check consent.
      const revokedSessions = await tx<{ id: string }[]>`
        update public.child_sessions set revoked_at = ${now}, revoke_reason = 'consent_withdrawn'
         where family_id = ${membership.familyId} and revoked_at is null
        returning id`;
      const revokedDevices = await tx<{ id: string }[]>`
        update public.child_devices set revoked_at = ${now}
         where family_id = ${membership.familyId} and revoked_at is null
        returning id`;
      await tx`
        update private.child_pairing_codes set consumed_at = ${now}
         where family_id = ${membership.familyId} and consumed_at is null`;
      await insertAudit(tx, {
        familyId: membership.familyId,
        actorUserId: parent.userId,
        action: 'consent.withdrawn',
        targetType: 'consent_record',
        targetId: latest.id,
        metadata: {
          cancelledJobs: cancelled.length,
          revokedSessions: revokedSessions.length,
          revokedDevices: revokedDevices.length,
        },
      });
      return { kind: 'withdrawn' as const, cancelledJobs: cancelled.length };
    });
    if (outcome.kind === 'none') throw new ApiError('NOT_FOUND', 'There is no consent to withdraw');
    if (outcome.kind === 'already') {
      throw new ApiError('CONFLICT', 'Consent was already withdrawn', {
        rule: CONSENT_RULES.alreadyWithdrawn,
      });
    }
    return c.json({ state: 'withdrawn', cancelledJobs: outcome.cancelledJobs });
  });

  r.post('/consent/:consentId/refresh', async (c) => {
    const { deps, parent } = c.var;
    const consentId = uuidSchema.safeParse(c.req.param('consentId'));
    if (!consentId.success) throw new ApiError('NOT_FOUND', 'Consent record not found');
    const membership = await callerMembership(c);
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `consent-refresh:${membership.familyId}`,
      RULES.consentRefreshPerFamily,
      now,
    );
    // Ownership: the record must belong to the caller's family (read under RLS as the caller).
    const [record] = await deps.db.asParent(
      parent,
      (tx) => tx<
        {
          id: string;
          status: string;
          provider: string;
          provider_reference: string | null;
          created_at: Date;
        }[]
      >`
        select id, status, provider, provider_reference, created_at from public.consent_records
         where id = ${consentId.data} and family_id = ${membership.familyId}`,
    );
    if (!record) throw new ApiError('NOT_FOUND', 'Consent record not found');
    const provider = deps.providers.consent;
    if (record.status === 'pending') {
      if (record.provider !== provider.name || record.provider_reference === null) {
        throw new ApiError('CONFLICT', 'Start consent again with the current provider', {
          rule: CONSENT_RULES.providerChanged,
        });
      }
      let result: Awaited<ReturnType<typeof provider.status>>;
      try {
        result = await provider.status(record.provider_reference);
      } catch {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          'The consent service is unavailable. Please try again later.',
        );
      }
      // Only a provider result can move a record out of pending; a client never can.
      if (result.status !== 'pending') {
        // Decision: record the provider's verification time, unless it predates the request
        // (implausible, e.g. a test double's epoch); then record when we observed the result.
        const reported = result.verifiedAt;
        const verifiedAt = reported && reported >= record.created_at ? reported : now;
        await deps.db.asService(async (tx) => {
          const verified = result.status === 'verified';
          const rows = await tx`
            update public.consent_records
               set status = ${result.status}, method = ${result.method},
                   verified_at = ${verified ? verifiedAt : null}
             where id = ${record.id} and family_id = ${membership.familyId} and status = 'pending'
            returning id`;
          if (rows.length === 1) {
            await insertAudit(tx, {
              familyId: membership.familyId,
              actorUserId: parent.userId,
              action: verified ? 'consent.verified' : 'consent.failed',
              targetType: 'consent_record',
              targetId: record.id,
              metadata: { testProvider: provider.isMock },
            });
          }
        });
      }
    }
    const [row] = await deps.db.asParent(
      parent,
      (tx) => tx<ConsentRow[]>`
        select id, status, is_test_provider, verified_at, withdrawn_at, policy_version
          from public.consent_records where id = ${record.id} and family_id = ${membership.familyId}`,
    );
    return c.json(consentView(row, deps));
  });

  return r;
}

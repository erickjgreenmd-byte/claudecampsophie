import { Hono } from 'hono';
import { isValidIanaZone } from '@pencillift/domain';
import {
  createChildProfileRequestSchema,
  createFamilyRequestSchema,
  updateChildProfileRequestSchema,
  updateFamilyRequestSchema,
  uuidSchema,
} from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { generatePairingCode, pairingCodeHash } from '../auth/pairing.ts';
import { acceptsTestProviderConsent } from '../config.ts';
import type { Tx } from '../db.ts';
import { ApiError, businessRule } from '../errors.ts';
import { consentAllowsChildAccess, hasVerifiedConsent } from '../services/consent.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';
import { toHex } from '../security/crypto.ts';

/**
 * Draft, active and archived profiles a family may hold at once, counting every profile that is
 * not archived (API-AUTH-R1-04). Well above the 4 paid slots: a bound on runaway clients, not a
 * product limit (archiving keeps history and frees room, spec P11).
 */
export const CHILD_PROFILE_LIMIT = 12;

/**
 * A child of the caller's family that is still visible, i.e. has no data deletion under way
 * (API-AUTH-R2-02, the same rule the learning, rewards and export reads apply). Spec P4 asks for a
 * deletion request to stop processing immediately, so activation, pairing and profile edits must all
 * refuse a child whose deletion is `requested` or `processing`: before this, `activate` looked only
 * at the status it had just set to `archived`, so a deletion-pending child could be made active
 * again, paired with a new device and used to collect new homework until the purge ran — and the
 * purge then removed the profile and everything added since, without warning.
 *
 * Returns undefined for an unknown id, another family's child and a child under deletion alike, so
 * a caller learns nothing from the difference (NOT_FOUND on every one).
 */
async function visibleChild(
  tx: Tx,
  familyId: string,
  childId: string,
): Promise<
  { status: string; nickname: string; grade_level: number; age_band: string } | undefined
> {
  const [row] = await tx<
    { status: string; nickname: string; grade_level: number; age_band: string }[]
  >`
    select c.status, c.nickname, c.grade_level, c.age_band from public.child_profiles c
      -- A whole-family deletion tombstones the family instead of the child row (migration 0600
      -- request_deletion), so the join covers that scope the way ownedChild's does.
      join public.families f on f.id = c.family_id and f.deleted_at is null
     where c.id = ${childId} and c.family_id = ${familyId}
       and not exists (
         select 1 from public.deletion_requests d
          where d.family_id = c.family_id and d.target_child_id = c.id
            and d.status in ('requested', 'processing'))`;
  return row;
}

/** Family, child profile and device management for signed-in parents. */
export function familyRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/families', requireParent);
  r.use('/family', requireParent);
  r.use('/children', requireParent);
  r.use('/children/*', requireParent);
  r.use('/devices/*', requireParent);

  r.post('/families', async (c) => {
    const { deps, parent } = c.var;
    const body = await readJson(c, createFamilyRequestSchema);
    if (!isValidIanaZone(body.timezone))
      throw new ApiError('VALIDATION_FAILED', 'Invalid time zone');
    try {
      const [row] = await deps.db.asParent(
        parent,
        (tx) =>
          tx<
            { id: string }[]
          >`select public.create_family(${body.displayName}, ${body.timezone}) as id`,
      );
      return c.json({ familyId: row!.id }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('verified email required'))
        throw new ApiError('FORBIDDEN', 'Verify your email first');
      if (message.includes('already belongs to a family'))
        throw new ApiError('CONFLICT', 'You already have a family');
      throw error;
    }
  });

  r.get('/family', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const data = await deps.db.asParent(parent, async (tx) => ({
      family: await tx<{ id: string; display_name: string; timezone: string }[]>`
        select id, display_name, timezone from public.families where id = ${familyId}`,
      children: await tx<
        {
          id: string;
          nickname: string;
          grade_level: number;
          age_band: string;
          status: string;
          deletion_pending: boolean;
        }[]
      >`
        select c.id, c.nickname, c.grade_level, c.age_band, c.status,
               -- A child whose data deletion is under way stays LISTED here and is flagged instead
               -- (API-AUTH-R2-02). Dropping it broke the one thing this list is for on the privacy
               -- screens: they resolve a nickname out of it for the pending-deletion list, that
               -- child's export rows and any safety report about it, so a family with two children
               -- could no longer tell which child a still-cancellable request covered. The rules
               -- that matter are enforced where they act: activation, pairing and profile edits go
               -- through visibleChild() and answer NOT_FOUND, with migration 0860's trigger as the
               -- database backstop. The flag lets the parent screens label the row and offer no
               -- control on it.
               exists (
                 select 1 from public.deletion_requests d
                  where d.family_id = c.family_id
                    and (d.scope = 'family' or d.target_child_id = c.id)
                    and d.status in ('requested', 'processing')) as deletion_pending
          from public.child_profiles c
         where c.family_id = ${familyId}
         order by c.created_at`,
      capacity: await tx<
        { paid_slots: number; conflict: string | null; managing_channel: string | null }[]
      >`
        select paid_slots, conflict, managing_channel from public.family_capacity where family_id = ${familyId}`,
    }));
    const family = data.family[0]!;
    return c.json({
      id: family.id,
      displayName: family.display_name,
      timezone: family.timezone,
      paidSlots: data.capacity[0]?.paid_slots ?? 0,
      billingConflict: data.capacity[0]?.conflict ?? null,
      managingChannel: data.capacity[0]?.managing_channel ?? null,
      children: data.children.map((ch) => ({
        id: ch.id,
        nickname: ch.nickname,
        gradeLevel: ch.grade_level,
        ageBand: ch.age_band,
        status: ch.status,
        deletionPending: ch.deletion_pending,
      })),
    });
  });

  /**
   * Correcting the family's name and time zone (WEB-R2-03). The zone was set once from the
   * browser's guess at creation and nothing could fix it afterwards, yet every schedule, review
   * release and report is planned in it. Step-up guarded and audited like every other family write.
   */
  r.patch('/family', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, updateFamilyRequestSchema);
    // The database check (families_timezone_iana, migration 0720) is the guarantee; this gives the
    // parent a field-level message instead of a constraint violation.
    if (body.timezone !== undefined && !isValidIanaZone(body.timezone))
      throw new ApiError('VALIDATION_FAILED', 'Invalid time zone');
    const row = await deps.db.asService(async (tx) => {
      const [updated] = await tx<{ id: string; display_name: string; timezone: string }[]>`
        update public.families
           set display_name = coalesce(${body.displayName ?? null}, display_name),
               timezone = coalesce(${body.timezone ?? null}, timezone)
         where id = ${familyId} and deleted_at is null
        returning id, display_name, timezone`;
      if (!updated) return undefined;
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
        values (${familyId}, ${parent.userId}, 'parent', 'family.profile_updated', 'family', ${familyId})`;
      return updated;
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Create your family first');
    return c.json({
      family: { id: row.id, displayName: row.display_name, timezone: row.timezone },
    });
  });

  // Adding a child creates an uncharged draft; activation requires a verified paid slot (spec P11).
  r.post('/children', async (c) => {
    const { deps } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    await enforceRateLimit(
      deps.rateLimiter,
      `child-create:${familyId}`,
      RATE_RULES.childCreatePerFamily,
      deps.clock(),
    );
    // The contract is the K-8, under-13 launch scope (API-AUTH-R1-05) and refuses control text.
    const body = await readJson(c, createChildProfileRequestSchema);
    const row = await deps.db.asService(async (tx) => {
      // Serialize with other profile changes for this family so the cap holds under a race.
      await tx`select 1 from public.families where id = ${familyId} for update`;
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.child_profiles
         where family_id = ${familyId} and status <> 'archived'`;
      if (count!.n >= CHILD_PROFILE_LIMIT) {
        throw businessRule(
          'CHILD_PROFILE_LIMIT',
          `A family can have up to ${CHILD_PROFILE_LIMIT} child profiles. Archive one you no longer use first.`,
        );
      }
      // Service role: the family id comes from the caller's verified membership (spec E4).
      const [inserted] = await tx<{ id: string }[]>`
        insert into public.child_profiles (family_id, nickname, grade_level, age_band)
        values (${familyId}, ${body.nickname}, ${body.gradeLevel}, ${body.ageBand}) returning id
      `;
      return inserted!;
    });
    return c.json({ childId: row.id, status: 'draft' }, 201);
  });

  /**
   * Correcting a child's nickname, grade and age band (WEB-R2-03). The grade is what practice
   * generation is pitched at (bankGrade/bankCoverage), so with no edit route every family stayed on
   * last year's grade once the school year rolled over, and the only workaround was deleting the
   * child's whole history. Step-up guarded and audited; an archived profile stays history-only
   * (spec P11), and a child under a data deletion is invisible (API-AUTH-R2-02).
   */
  r.patch('/children/:childId', async (c) => {
    const { deps, parent } = c.var;
    const childId = uuidSchema.safeParse(c.req.param('childId'));
    if (!childId.success) throw new ApiError('NOT_FOUND', 'Child not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, updateChildProfileRequestSchema);
    const row = await deps.db.asService(async (tx) => {
      // Serialize with the family's other profile changes so a concurrent archive or activation
      // cannot land between the check below and the update.
      await tx`select 1 from public.families where id = ${familyId} for update`;
      // Service role bypasses RLS, so ownership is checked explicitly (spec E4).
      const child = await visibleChild(tx, familyId, childId.data);
      if (!child) throw new ApiError('NOT_FOUND', 'Child not found');
      if (child.status === 'archived') {
        throw businessRule(
          'CHILD_ARCHIVED',
          'This child’s profile is archived. Its history stays available, but nothing can be changed unless the profile is active again.',
        );
      }
      const [updated] = await tx<
        { id: string; nickname: string; grade_level: number; age_band: string; status: string }[]
      >`
        update public.child_profiles
           set nickname = coalesce(${body.nickname ?? null}, nickname),
               grade_level = coalesce(${body.gradeLevel ?? null}::int, grade_level),
               age_band = coalesce(${body.ageBand ?? null}, age_band)
         where id = ${childId.data} and family_id = ${familyId}
        returning id, nickname, grade_level, age_band, status`;
      if (!updated) throw new ApiError('NOT_FOUND', 'Child not found');
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
        values (${familyId}, ${parent.userId}, 'parent', 'child.profile_updated', 'child', ${childId.data},
                ${JSON.stringify({ fields: Object.keys(body).sort() })}::text::jsonb)`;
      return updated;
    });
    return c.json({
      child: {
        id: row.id,
        nickname: row.nickname,
        gradeLevel: row.grade_level,
        ageBand: row.age_band,
        status: row.status,
      },
    });
  });

  r.post('/children/:childId/pairing-code', async (c) => {
    const { deps, parent } = c.var;
    const childId = uuidSchema.safeParse(c.req.param('childId'));
    if (!childId.success) throw new ApiError('NOT_FOUND', 'Child not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const now = deps.clock();
    await enforceRateLimit(
      deps.rateLimiter,
      `pairing-create:${familyId}`,
      RATE_RULES.pairingCreatePerFamily,
      now,
    );
    // A child under a data deletion is NOT_FOUND here too (API-AUTH-R2-02): spec P4 stops
    // processing at the request, so no new device may be paired while the purge is pending.
    const child = await deps.db.asParent(parent, (tx) => visibleChild(tx, familyId, childId.data));
    if (!child) throw new ApiError('NOT_FOUND', 'Child not found');
    if (child.status !== 'active') {
      throw new ApiError(
        'BUSINESS_RULE',
        'Assign a paid slot to this child before pairing a device',
        {
          rule: 'CHILD_NOT_ACTIVE',
        },
      );
    }
    // Withdrawn (or otherwise no longer verified) consent stops new devices too (CS-R1-01).
    const consentOk = await deps.db.asService((tx) =>
      consentAllowsChildAccess(tx, familyId, {
        allowTestProvider: acceptsTestProviderConsent(deps.config.environment),
      }),
    );
    if (!consentOk) {
      throw businessRule(
        'CONSENT_REQUIRED',
        'Parental consent is needed before a device can be paired. Give consent again on the family page first.',
      );
    }
    const code = generatePairingCode(deps.random);
    const hashHex = toHex(await pairingCodeHash(deps.config.hashPepper, code));
    const expiresAt = new Date(now.getTime() + deps.config.pairingCodeTtlSeconds * 1000);
    await deps.db.asService(async (tx) => {
      // Child row first, as the insert trigger (0720) does: a code row locked before the child row
      // deadlocks with an overlapping request (BUG-106).
      await tx`select 1 from public.child_profiles where id = ${childId.data} for no key update`;
      // One live code per child: older unused codes stop working.
      await tx`update private.child_pairing_codes set consumed_at = ${now} where child_id = ${childId.data} and consumed_at is null`;
      await tx`
        insert into private.child_pairing_codes (family_id, child_id, code_hash, created_by, created_at, expires_at)
        values (${familyId}, ${childId.data}, decode(${hashHex}, 'hex'), ${parent.userId}, ${now}, ${expiresAt})
      `;
    });
    return c.json(
      { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: expiresAt.toISOString() },
      201,
    );
  });

  // Activation assigns one verified paid slot (spec P11: a draft is free; activation never buys).
  r.post('/children/:childId/activate', async (c) => {
    const { deps, parent } = c.var;
    const childId = uuidSchema.safeParse(c.req.param('childId'));
    if (!childId.success) throw new ApiError('NOT_FOUND', 'Child not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    // A development-mock consent record counts only where that mock may be wired (LRD-1).
    const allowTestProvider = acceptsTestProviderConsent(deps.config.environment);
    const result = await deps.db.asService(async (tx) => {
      // Serialize with other slot changes for this family (two guardians, two devices).
      await tx`select 1 from public.families where id = ${familyId} for update`;
      // Service role bypasses RLS, so ownership is checked explicitly (spec E4). A child whose data
      // deletion is `requested` or `processing` is NOT_FOUND, never re-activated (API-AUTH-R2-02):
      // spec P4 stops processing at the request, and the purge would later remove the re-activated
      // profile and every scan added since without warning.
      const child = await visibleChild(tx, familyId, childId.data);
      if (!child) throw new ApiError('NOT_FOUND', 'Child not found');
      if (child.status === 'active') return slotSummary(tx, familyId, 'active');
      if (!(await hasVerifiedConsent(tx, familyId, { allowTestProvider }))) {
        throw businessRule(
          'CONSENT_REQUIRED',
          'Parental consent is needed before a child can start',
        );
      }
      const [capacity] = await tx<{ paid_slots: number; open: number }[]>`
        select coalesce((select paid_slots from public.family_capacity where family_id = ${familyId}), 0)::int as paid_slots,
               (select count(*)::int from public.child_slot_assignments
                 where family_id = ${familyId} and released_at is null) as open`;
      if (capacity!.open >= capacity!.paid_slots) {
        throw businessRule(
          'NEEDS_PAID_SLOT',
          `All ${capacity!.paid_slots} paid child slots are in use. Add a child slot to your plan first.`,
        );
      }
      await tx`insert into public.child_slot_assignments (family_id, child_id) values (${familyId}, ${childId.data})`;
      await tx`update public.child_profiles set status = 'active', archived_at = null
                where id = ${childId.data} and family_id = ${familyId}`;
      await tx`
        insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
        values (${familyId}, ${parent.userId}, 'parent', 'child.activated', 'child', ${childId.data})`;
      return slotSummary(tx, familyId, 'active');
    });
    return c.json({ childId: childId.data, ...result });
  });

  // Archiving frees the slot and ends the child's sessions but keeps history (spec P11, AC_CAPACITY_08).
  // It never claims to cancel or lower a store subscription.
  r.post('/children/:childId/archive', async (c) => {
    const { deps, parent } = c.var;
    const childId = uuidSchema.safeParse(c.req.param('childId'));
    if (!childId.success) throw new ApiError('NOT_FOUND', 'Child not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const result = await deps.db.asService(async (tx) => {
      await tx`select 1 from public.families where id = ${familyId} for update`;
      const [child] = await tx<{ status: string }[]>`
        select status from public.child_profiles where id = ${childId.data} and family_id = ${familyId}`;
      if (!child) throw new ApiError('NOT_FOUND', 'Child not found');
      if (child.status !== 'archived') {
        await tx`update public.child_slot_assignments set released_at = now(), release_reason = 'archived'
                  where family_id = ${familyId} and child_id = ${childId.data} and released_at is null`;
        await tx`update public.child_profiles set status = 'archived', archived_at = now()
                  where id = ${childId.data} and family_id = ${familyId}`;
        await tx`update public.child_sessions set revoked_at = now(), revoke_reason = 'child_archived'
                  where family_id = ${familyId} and child_id = ${childId.data} and revoked_at is null`;
        await tx`update public.child_devices set revoked_at = now()
                  where family_id = ${familyId} and child_id = ${childId.data} and revoked_at is null`;
        await tx`
          insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
          values (${familyId}, ${parent.userId}, 'parent', 'child.archived', 'child', ${childId.data})`;
      }
      return slotSummary(tx, familyId, 'archived');
    });
    return c.json({
      childId: childId.data,
      ...result,
      note: 'Your store subscription is unchanged. Change the plan in the store to lower the price.',
    });
  });

  r.get('/devices', requireParent, async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    const rows = await deps.db.asParent(
      parent,
      (tx) => tx<
        {
          id: string;
          child_id: string;
          label: string;
          platform: string;
          paired_at: Date;
          revoked_at: Date | null;
        }[]
      >`
        select id, child_id, label, platform, paired_at, revoked_at from public.child_devices
         where family_id = ${familyId} order by paired_at desc`,
    );
    return c.json({
      devices: rows.map((d) => ({
        id: d.id,
        childId: d.child_id,
        label: d.label,
        platform: d.platform,
        pairedAt: d.paired_at.toISOString(),
        revokedAt: d.revoked_at?.toISOString() ?? null,
      })),
    });
  });

  r.post('/devices/:deviceId/revoke', async (c) => {
    const { deps } = c.var;
    const deviceId = uuidSchema.safeParse(c.req.param('deviceId'));
    if (!deviceId.success) throw new ApiError('NOT_FOUND', 'Device not found');
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const revoked = await deps.db.asService(async (tx) => {
      // Service role bypasses RLS, so ownership is checked explicitly (spec E4).
      const rows = await tx<{ id: string }[]>`
        update public.child_devices set revoked_at = now()
         where id = ${deviceId.data} and family_id = ${familyId} and revoked_at is null returning id`;
      if (rows.length === 0) return false;
      await tx`update public.child_sessions set revoked_at = now(), revoke_reason = 'device_revoked'
                where device_id = ${deviceId.data} and revoked_at is null`;
      return true;
    });
    if (!revoked) throw new ApiError('NOT_FOUND', 'Device not found');
    return c.json({ ok: true });
  });

  return r;
}

async function slotSummary(
  tx: Tx,
  familyId: string,
  status: 'active' | 'archived',
): Promise<{ status: 'active' | 'archived'; paidSlots: number; assignedSlots: number }> {
  const [row] = await tx<{ paid_slots: number; open: number }[]>`
    select coalesce((select paid_slots from public.family_capacity where family_id = ${familyId}), 0)::int as paid_slots,
           (select count(*)::int from public.child_slot_assignments
             where family_id = ${familyId} and released_at is null) as open`;
  return { status, paidSlots: row!.paid_slots, assignedSlots: row!.open };
}

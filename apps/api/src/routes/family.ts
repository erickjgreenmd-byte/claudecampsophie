import { Hono } from 'hono';
import { z } from 'zod';
import { isValidIanaZone } from '@pencillift/domain';
import { uuidSchema } from '@pencillift/contracts';
import { readJson } from '../app.ts';
import { generatePairingCode, pairingCodeHash } from '../auth/pairing.ts';
import { ApiError } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';
import { enforceRateLimit, RATE_RULES } from '../middleware/rate-limit.ts';
import { toHex } from '../security/crypto.ts';

const createFamilySchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(64),
});

const createChildSchema = z.strictObject({
  nickname: z.string().trim().min(1).max(40),
  gradeLevel: z.number().int().min(0).max(12),
  ageBand: z.enum(['5-7', '8-10', '11-13', '14-18']),
});

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
    const body = await readJson(c, createFamilySchema);
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
        { id: string; nickname: string; grade_level: number; age_band: string; status: string }[]
      >`
        select id, nickname, grade_level, age_band, status from public.child_profiles
         where family_id = ${familyId} order by created_at`,
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
      })),
    });
  });

  // Adding a child creates an uncharged draft; activation requires a verified paid slot (spec P11).
  r.post('/children', async (c) => {
    const { deps, parent } = c.var;
    const familyId = await currentFamilyId(c);
    await assertRecentUnlock(c);
    const body = await readJson(c, createChildSchema);
    const [row] = await deps.db.asParent(
      parent,
      (tx) => tx<{ id: string }[]>`
        insert into public.child_profiles (family_id, nickname, grade_level, age_band)
        values (${familyId}, ${body.nickname}, ${body.gradeLevel}, ${body.ageBand}) returning id
      `,
    );
    return c.json({ childId: row!.id, status: 'draft' }, 201);
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
    const [child] = await deps.db.asParent(
      parent,
      (tx) =>
        tx<
          { status: string }[]
        >`select status from public.child_profiles where id = ${childId.data} and family_id = ${familyId}`,
    );
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
    const code = generatePairingCode(deps.random);
    const hashHex = toHex(await pairingCodeHash(deps.config.hashPepper, code));
    const expiresAt = new Date(now.getTime() + deps.config.pairingCodeTtlSeconds * 1000);
    await deps.db.asService(async (tx) => {
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

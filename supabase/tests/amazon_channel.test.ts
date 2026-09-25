import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../scripts/migrate.ts';
import { seedFamily, type SeededFamily } from './fixtures.ts';
import { createTestDb, type TestDb, type Tx } from './harness.ts';

// Migration 0800: the Amazon Appstore (Fire tablets) is the fourth billing channel. Every channel
// check constraint from 0200/0300/0640/0700 must accept 'amazon_appstore' next to the three original
// values and still refuse anything else. The migration finds the constraints by their live names in
// pg_constraint, so applying it again changes nothing. Synthetic families only (Riley).

const MIGRATION = '0800_amazon_appstore_channel.sql';
const OLD_CHANNELS = ['app_store', 'play_store', 'stripe'] as const;
const NEW_CHANNEL = 'amazon_appstore';
const UNKNOWN_CHANNEL = 'roku';

interface ChannelColumn {
  readonly table: string;
  readonly column: string;
  /** A row valid in every respect except, possibly, the channel value. */
  readonly insert: (tx: Tx, channel: string) => Promise<unknown>;
}

interface ConstraintRow {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

let db: TestDb;
let fam: SeededFamily;
let campaignId: string;
let codeId: string;

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back: the database's error message, or null. */
async function attempt(fn: (tx: Tx) => Promise<unknown>): Promise<string | null> {
  try {
    await db.sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback('rolled back on purpose');
    });
    return null;
  } catch (error) {
    if (error instanceof Rollback) return null;
    return error instanceof Error ? error.message : String(error);
  }
}

async function redemption(tx: Tx, channel: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.promo_redemptions (family_id, campaign_id, code_id, channel, target_period_key, idempotency_key,
      paid_slots, percent_off, regular_cents, discount_cents, charged_cents, redeemed_by)
    values (${fam.familyId}, ${campaignId}, ${codeId}, ${channel}, ${'first:' + channel}, ${'idem-' + randomUUID()},
      1, 50, 3999, 2000, 1999, ${fam.ownerId})
    returning id`;
  return row!.id;
}

const CHANNEL_COLUMNS: readonly ChannelColumn[] = [
  {
    table: 'store_product_mappings',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.store_product_mappings (channel, product_id, environment, paid_slots)
      values (${channel}, ${'pl_' + randomUUID()}, 'sandbox', 1)`,
  },
  {
    table: 'family_entitlements',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.family_entitlements (family_id, channel, provider_subscription_id, product_id, paid_slots,
        status, environment, period_start, period_end, provider_updated_at, fetched_at)
      values (${fam.familyId}, ${channel}, ${'rc:' + randomUUID()}, 'pl_family_1', 1, 'active', 'sandbox',
        now(), now() + interval '1 month', now(), now())`,
  },
  {
    table: 'family_capacity',
    column: 'managing_channel',
    insert: (tx, channel) => tx`
      insert into public.family_capacity (family_id, paid_slots, managing_channel)
      values (${fam.familyId}, 1, ${channel})
      on conflict (family_id) do update
        set paid_slots = excluded.paid_slots, managing_channel = excluded.managing_channel`,
  },
  {
    table: 'billing_periods',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.billing_periods (family_id, channel, provider_period_id, kind, period_start, period_end,
        paid_slots, regular_amount_cents, charged_amount_cents, settlement, settled_at)
      values (${fam.familyId}, ${channel}, ${'tx-' + randomUUID()}, 'subscription_period', now(),
        now() + interval '1 month', 1, 3999, 3999, 'settled', now())`,
  },
  {
    table: 'promo_campaign_templates',
    column: 'channels',
    insert: (tx, channel) => tx`
      insert into public.promo_campaign_templates (name, percent_off, eligible_tiers, subscriber_eligibility,
        redemption_cap, budget_cap_cents, code_mode, channels, created_by)
      values ('Fire tablets', 50, '{1}', '{existing}', 10, 100000, 'shared', array[${channel}::text], ${fam.ownerId})`,
  },
  {
    table: 'provider_offer_mappings',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.provider_offer_mappings (campaign_id, channel, paid_slots)
      values (${campaignId}, ${channel}, 1)`,
  },
  { table: 'promo_redemptions', column: 'channel', insert: redemption },
  {
    table: 'promo_benefit_periods',
    column: 'channel',
    insert: async (tx, channel) => {
      // The benefit period's own channel is under test, so its redemption uses a known-good one.
      const redemptionId = await redemption(tx, 'app_store');
      return tx`
        insert into public.promo_benefit_periods (redemption_id, family_id, channel, provider_period_id, period_start, period_end)
        values (${redemptionId}, ${fam.familyId}, ${channel}, ${'tx-' + randomUUID()}, now(), now() + interval '1 month')`;
    },
  },
  {
    table: 'store_feature_mappings',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.store_feature_mappings (channel, product_id, environment, feature)
      values (${channel}, ${'adfree_' + randomUUID()}, 'sandbox', 'ad_free')`,
  },
  {
    table: 'pending_refunds',
    column: 'channel',
    insert: (tx, channel) => tx`
      insert into public.pending_refunds (family_id, channel, provider_period_id, kind)
      values (${fam.familyId}, ${channel}, ${'tx-' + randomUUID()}, 'refund')`,
  },
];

/** Every check constraint in public that enumerates billing channels, by table and name. */
async function channelConstraints(): Promise<ConstraintRow[]> {
  return db.sql<ConstraintRow[]>`
    select c.relname as "table", k.conname as "name", pg_get_constraintdef(k.oid) as "definition"
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and k.contype = 'c'
       and pg_get_constraintdef(k.oid) like '%''play_store''%'
     order by c.relname, k.conname`;
}

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db);
  const [tpl] = await db.sql<{ id: string }[]>`
    insert into public.promo_campaign_templates (name, percent_off, eligible_tiers, subscriber_eligibility,
      redemption_cap, budget_cap_cents, code_mode, channels, created_by)
    values ('Amazon channel test', 50, '{1}', '{existing}', 10, 100000, 'shared', '{app_store}', ${fam.ownerId})
    returning id`;
  const [camp] = await db.sql<{ id: string }[]>`
    insert into public.promo_campaigns (template_id, campaign_month, generation_key, percent_off, eligible_tiers,
      subscriber_eligibility, redemption_cap, budget_cap_cents, opens_at, closes_at, status)
    values (${tpl!.id}, '2026-10', ${tpl!.id + ':2026-10'}, 50, '{1}', '{existing}', 10, 100000,
      '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'active')
    returning id`;
  campaignId = camp!.id;
  const [code] = await db.sql<{ id: string }[]>`
    insert into public.promo_codes (campaign_id, code_normalized) values (${campaignId}, 'ABCDEFGH01X') returning id`;
  codeId = code!.id;
});

afterAll(async () => {
  await db?.drop();
});

describe('migration 0800: amazon_appstore billing channel', () => {
  it('every channel constraint allows amazon_appstore; none listing only the old channels remains', async () => {
    const rows = await channelConstraints();
    expect(rows.filter((r) => !r.definition.includes("'amazon_appstore'"))).toEqual([]);
    for (const old of OLD_CHANNELS) {
      expect(rows.every((r) => r.definition.includes(`'${old}'`))).toBe(true);
    }
    expect(rows.map((r) => `${r.table}.${r.name}`).sort()).toEqual(
      CHANNEL_COLUMNS.map((c) => `${c.table}.${c.table}_${c.column}_check`).sort(),
    );
  });

  describe.each(CHANNEL_COLUMNS)('$table.$column', (column) => {
    it.each([...OLD_CHANNELS, NEW_CHANNEL])('accepts %s', async (channel) => {
      expect(await attempt((tx) => column.insert(tx, channel))).toBeNull();
    });

    it('refuses an unknown channel through the channel constraint', async () => {
      const message = await attempt((tx) => column.insert(tx, UNKNOWN_CHANNEL));
      expect(message).toMatch(
        new RegExp(`violates check constraint "${column.table}_${column.column}_check"`),
      );
    });
  });

  it('a template may target the Amazon Appstore with other stores, never an unknown store or nothing', async () => {
    const insert = (channels: string) =>
      attempt((tx) =>
        tx.unsafe(`
          insert into public.promo_campaign_templates (name, percent_off, eligible_tiers, subscriber_eligibility,
            redemption_cap, budget_cap_cents, code_mode, channels, created_by)
          values ('Fire tablets', 50, '{1}', '{existing}', 10, 100000, 'shared', ${channels}, '${fam.ownerId}')`),
      );
    expect(await insert(`array['app_store', 'amazon_appstore']`)).toBeNull();
    expect(
      await insert(`array['app_store', 'play_store', 'stripe', 'amazon_appstore']`),
    ).toBeNull();
    expect(await insert(`array['app_store', 'amazon']`)).toMatch(
      /violates check constraint "promo_campaign_templates_channels_check"/,
    );
    expect(await insert(`'{}'::text[]`)).toMatch(
      /violates check constraint "promo_campaign_templates_channels_check"/,
    );
  });

  it('is idempotent: applying 0800 again leaves the constraints exactly as they are', async () => {
    const before = await channelConstraints();
    const text = await readFile(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
    await db.sql.begin(async (tx) => {
      await tx.unsafe(text);
    });
    expect(await channelConstraints()).toEqual(before);
    expect(await attempt((tx) => CHANNEL_COLUMNS[0]!.insert(tx, NEW_CHANNEL))).toBeNull();
  });
});

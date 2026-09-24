-- 0300_promotions_schools.sql
-- P17: schools, one-school-per-family designations, signup attribution, monthly campaign templates,
-- generated campaigns and codes, provider offer mappings, redemptions (durable provider-operation
-- state machine), confirmed benefit periods, donation accruals/adjustments and payout batches.
-- Depends on 0001 and 0200 (billing_periods). See docs/Architecture.md §6 and spec P17.

-- ---------------------------------------------------------------------------------------------
-- Schools and attribution
-- ---------------------------------------------------------------------------------------------

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 160),
  city text check (char_length(city) <= 80),
  region text check (char_length(region) <= 40),
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'active', 'inactive')),
  -- Payout recipient verified by the owner out of band; no banking details are stored here.
  recipient_verified boolean not null default false,
  created_at timestamptz not null default now()
);

-- A school code attributes a signup without any discount (attribution is independent of promos).
create table public.school_referral_codes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id),
  code_normalized text not null unique check (code_normalized ~ '^[0-9A-Z]{6,16}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.school_admins (
  school_id uuid not null references public.schools (id),
  user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (school_id, user_id)
);

-- Signup attribution history: at most one current attribution per family.
create table public.family_school_attributions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  school_id uuid not null references public.schools (id),
  source text not null check (source in ('school_code', 'promo', 'manual')),
  attributed_at timestamptz not null default now(),
  superseded_at timestamptz
);

create unique index family_school_attributions_current
  on public.family_school_attributions (family_id) where superseded_at is null;

-- One school per family: effective months as [from, to) date ranges that may never overlap.
create table public.family_school_designations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  school_id uuid not null references public.schools (id),
  -- First day of the program calendar month in which donations start for this school.
  effective_from date not null check (extract(day from effective_from) = 1),
  -- Exclusive end month (first day); null while current.
  effective_to date check (effective_to is null or extract(day from effective_to) = 1),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  constraint family_school_designations_no_overlap exclude using gist (
    family_id with =,
    daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[)') with &&
  )
);

-- ---------------------------------------------------------------------------------------------
-- Monthly campaigns
-- ---------------------------------------------------------------------------------------------

create table public.promo_campaign_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  school_id uuid references public.schools (id),
  percent_off smallint not null check (percent_off between 5 and 100),
  eligible_tiers smallint[] not null check (cardinality(eligible_tiers) > 0 and eligible_tiers <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  subscriber_eligibility text[] not null
    check (cardinality(subscriber_eligibility) > 0 and subscriber_eligibility <@ array['new', 'existing', 'lapsed']),
  redemption_cap integer not null check (redemption_cap > 0),
  -- Never unlimited (spec P17: do not silently invent unlimited campaign budgets).
  budget_cap_cents integer not null check (budget_cap_cents > 0),
  calendar_timezone text not null default 'UTC',
  timezone_confirmed boolean not null default false,
  window_start_day smallint not null default 1 check (window_start_day between 1 and 28),
  -- 0 means end of month.
  window_end_day smallint not null default 0 check (window_end_day between 0 and 31),
  code_mode text not null check (code_mode in ('shared', 'individual')),
  individual_code_count integer check (individual_code_count > 0),
  shared_code_usage_cap integer check (shared_code_usage_cap > 0),
  channels text[] not null check (cardinality(channels) > 0 and channels <@ array['app_store', 'play_store', 'stripe']),
  enabled boolean not null default false,
  paused boolean not null default false,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (code_mode <> 'individual' or individual_code_count is not null),
  -- Activation requires an explicitly confirmed calendar timezone.
  check (not enabled or timezone_confirmed)
);

create trigger promo_campaign_templates_touch before update on public.promo_campaign_templates
  for each row execute function app.touch_updated_at();

create table public.promo_campaigns (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.promo_campaign_templates (id),
  campaign_month text not null check (campaign_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- `${template_id}:${campaign_month}`: retries and concurrent workers cannot generate twice.
  generation_key text not null unique,
  school_id uuid references public.schools (id),
  percent_off smallint not null check (percent_off between 5 and 100),
  eligible_tiers smallint[] not null,
  subscriber_eligibility text[] not null,
  redemption_cap integer not null check (redemption_cap > 0),
  budget_cap_cents integer not null check (budget_cap_cents > 0),
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'paused', 'revoked', 'ended', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, campaign_month),
  check (generation_key = template_id::text || ':' || campaign_month),
  check (closes_at > opens_at)
);

create trigger promo_campaigns_touch before update on public.promo_campaigns
  for each row execute function app.touch_updated_at();

create table public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.promo_campaigns (id),
  -- Normalized Crockford base32 incl. check symbol.
  code_normalized text not null unique check (code_normalized ~ '^[0-9A-HJKMNP-TV-Z]{10}[0-9A-HJKMNP-TV-Z*~$=U]$'),
  usage_cap integer check (usage_cap > 0),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now()
);

create index promo_codes_campaign on public.promo_codes (campaign_id);

create table public.provider_offer_mappings (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.promo_campaigns (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  paid_slots smallint not null check (paid_slots between 1 and 12),
  provider_offer_id text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'unsupported')),
  reason text,
  updated_at timestamptz not null default now(),
  unique (campaign_id, channel, paid_slots),
  check (status <> 'ready' or provider_offer_id is not null),
  check (status not in ('failed', 'unsupported') or reason is not null)
);

-- ---------------------------------------------------------------------------------------------
-- Redemptions: durable provider-operation state machine
-- ---------------------------------------------------------------------------------------------

create table public.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  campaign_id uuid not null references public.promo_campaigns (id),
  code_id uuid not null references public.promo_codes (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  -- 'first:<channel>' for a new subscriber's first full period, else the provider period start (ISO).
  target_period_key text not null check (char_length(target_period_key) between 1 and 80),
  target_period_start timestamptz,
  state text not null default 'reserved'
    check (state in ('reserved', 'provider_pending', 'confirmed', 'rejected', 'expired', 'reconciled')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  paid_slots smallint not null check (paid_slots between 1 and 12),
  percent_off smallint not null check (percent_off between 5 and 100),
  regular_cents integer not null check (regular_cents > 0),
  -- Preview at reservation; replaced by the provider-reported amount on confirmation.
  discount_cents integer not null check (discount_cents >= 0),
  charged_cents integer not null check (charged_cents >= 0),
  provider_reference text,
  redeemed_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  check (discount_cents + charged_cents = regular_cents),
  check (state not in ('confirmed', 'reconciled') or confirmed_at is not null)
);

-- Each family can redeem once per campaign (across guardians, devices, reinstalls and channels).
create unique index promo_redemptions_once_per_campaign
  on public.promo_redemptions (family_id, campaign_id)
  where state in ('reserved', 'provider_pending', 'confirmed', 'reconciled');

-- One discount per family billing period: no stacking two codes on one invoice.
create unique index promo_redemptions_one_per_period
  on public.promo_redemptions (family_id, target_period_key)
  where state in ('reserved', 'provider_pending', 'confirmed', 'reconciled');

-- At most one in-flight (not yet provider-decided) redemption per family.
create unique index promo_redemptions_one_in_flight
  on public.promo_redemptions (family_id)
  where state in ('reserved', 'provider_pending');

create index promo_redemptions_campaign on public.promo_redemptions (campaign_id, state);

create trigger promo_redemptions_touch before update on public.promo_redemptions
  for each row execute function app.touch_updated_at();

-- Mirrors @pencillift/domain/promotions transitionRedemption: defense in depth.
create or replace function app.guard_redemption_transition() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is distinct from old.state and not (
       (old.state = 'reserved' and new.state in ('provider_pending', 'expired'))
    or (old.state = 'provider_pending' and new.state in ('confirmed', 'rejected'))
    or (old.state = 'confirmed' and new.state = 'reconciled')
  ) then
    raise exception 'invalid redemption transition % -> %', old.state, new.state using errcode = 'P0001';
  end if;
  if new.family_id <> old.family_id or new.campaign_id <> old.campaign_id or new.code_id <> old.code_id
     or new.target_period_key <> old.target_period_key or new.idempotency_key <> old.idempotency_key
     or new.redeemed_by <> old.redeemed_by then
    raise exception 'redemption identity is immutable' using errcode = 'P0001';
  end if;
  if old.state in ('confirmed', 'reconciled') and (
       new.discount_cents <> old.discount_cents or new.charged_cents <> old.charged_cents) then
    raise exception 'confirmed redemption amounts are immutable' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger promo_redemptions_transition before update on public.promo_redemptions
  for each row execute function app.guard_redemption_transition();

create or replace function app.no_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rows in %.% are never deleted', tg_table_schema, tg_table_name using errcode = 'P0001';
end
$$;

create trigger promo_redemptions_no_delete before delete on public.promo_redemptions
  for each row execute function app.no_delete();

-- Confirmed benefit bound to exactly one provider billing period.
create table public.promo_benefit_periods (
  id uuid primary key default gen_random_uuid(),
  redemption_id uuid not null unique references public.promo_redemptions (id),
  family_id uuid not null references public.families (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  provider_period_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_at timestamptz not null default now(),
  unique (family_id, period_start),
  unique (channel, provider_period_id),
  check (period_end > period_start)
);

create trigger promo_benefit_periods_append_only before update or delete on public.promo_benefit_periods
  for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- Donation ledger and payouts
-- ---------------------------------------------------------------------------------------------

create table public.donation_payout_batches (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id),
  -- Idempotency key for submission; retries reuse it, so a transfer can never be sent twice.
  batch_key text not null unique check (char_length(batch_key) between 8 and 200),
  total_cents integer not null check (total_cents > 0),
  status text not null default 'accrued' check (status in ('accrued', 'approved', 'paid', 'failed', 'adjusted')),
  external_transfer_ref text unique,
  failure_reason text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  paid_at timestamptz,
  check (status <> 'paid' or (external_transfer_ref is not null and paid_at is not null))
);

create table public.donation_accruals (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  school_id uuid not null references public.schools (id),
  -- Program calendar month containing the qualifying period's start (YYYY-MM).
  donation_month text not null check (donation_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_cents integer not null default 100 check (amount_cents = 100),
  billing_period_id uuid not null unique references public.billing_periods (id),
  eligibility_snapshot jsonb not null,
  payout_batch_id uuid references public.donation_payout_batches (id),
  created_at timestamptz not null default now(),
  -- One $1 per family per calendar month, whatever the school, anchors or retries.
  unique (family_id, donation_month)
);

create index donation_accruals_school_month on public.donation_accruals (school_id, donation_month);

create table public.donation_adjustments (
  id uuid primary key default gen_random_uuid(),
  accrual_id uuid not null references public.donation_accruals (id),
  amount_cents integer not null check (amount_cents in (-100, 100)),
  reason text not null check (reason in ('refund', 'partial_refund', 'chargeback', 'chargeback_reversed')),
  idempotency_key text not null unique,
  payout_batch_id uuid references public.donation_payout_batches (id),
  created_at timestamptz not null default now()
);

-- Financial facts are immutable: only the one-time assignment to a payout batch is allowed.
create or replace function app.guard_ledger_row() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger rows in %.% are never deleted', tg_table_schema, tg_table_name using errcode = 'P0001';
  end if;
  if old.payout_batch_id is not null and new.payout_batch_id is distinct from old.payout_batch_id then
    raise exception 'ledger row already belongs to a payout batch' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'payout_batch_id') <> (to_jsonb(old) - 'payout_batch_id') then
    raise exception 'ledger facts are immutable; record an adjustment' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger donation_accruals_guard before update or delete on public.donation_accruals
  for each row execute function app.guard_ledger_row();
create trigger donation_adjustments_guard before update or delete on public.donation_adjustments
  for each row execute function app.guard_ledger_row();

-- ---------------------------------------------------------------------------------------------
-- School-facing aggregate report (privacy-suppressed; no family identities)
-- ---------------------------------------------------------------------------------------------

create or replace function app.is_school_admin(p_school uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.school_admins a
     where a.school_id = p_school and a.user_id = app.current_user_id() and a.revoked_at is null
  )
$$;

revoke execute on function app.is_school_admin(uuid) from public, anon;
grant execute on function app.is_school_admin(uuid) to authenticated, service_role;

create or replace function public.school_month_report(p_school uuid, p_month text)
returns table (
  school_id uuid,
  donation_month text,
  attributed_signups text,
  donation_eligible_families text,
  accrued_cents bigint,
  paid_cents bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  signups bigint;
  eligible bigint;
  accrued bigint;
  paid bigint;
  exact boolean := app.is_owner_admin();
begin
  if not (exact or app.is_school_admin(p_school)) then
    raise exception 'not authorized for this school' using errcode = '42501';
  end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  select count(distinct a.family_id) into signups
    from public.family_school_attributions a
   where a.school_id = p_school and a.superseded_at is null;
  select count(distinct d.family_id),
         coalesce(sum(d.amount_cents), 0) + coalesce((
           select sum(j.amount_cents) from public.donation_adjustments j
             join public.donation_accruals d2 on d2.id = j.accrual_id
            where d2.school_id = p_school and d2.donation_month = p_month), 0),
         coalesce(sum(d.amount_cents) filter (where b.status = 'paid'), 0)
    into eligible, accrued, paid
    from public.donation_accruals d
    left join public.donation_payout_batches b on b.id = d.payout_batch_id
   where d.school_id = p_school and d.donation_month = p_month;
  -- Small cohorts are suppressed for school viewers; amounts too, because $1/family reveals the count.
  return query select
    p_school,
    p_month,
    case when exact or signups = 0 or signups >= 5 then signups::text else '<5' end,
    case when exact or eligible = 0 or eligible >= 5 then eligible::text else '<5' end,
    case when exact or eligible = 0 or eligible >= 5 then accrued else null end,
    case when exact or eligible = 0 or eligible >= 5 then paid else null end;
end
$$;

revoke execute on function public.school_month_report(uuid, text) from public, anon;
grant execute on function public.school_month_report(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.schools enable row level security;
alter table public.school_referral_codes enable row level security;
alter table public.school_admins enable row level security;
alter table public.family_school_attributions enable row level security;
alter table public.family_school_designations enable row level security;
alter table public.promo_campaign_templates enable row level security;
alter table public.promo_campaigns enable row level security;
alter table public.promo_codes enable row level security;
alter table public.provider_offer_mappings enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.promo_benefit_periods enable row level security;
alter table public.donation_payout_batches enable row level security;
alter table public.donation_accruals enable row level security;
alter table public.donation_adjustments enable row level security;

revoke all on public.schools, public.school_referral_codes, public.school_admins,
  public.family_school_attributions, public.family_school_designations,
  public.promo_campaign_templates, public.promo_campaigns, public.promo_codes,
  public.provider_offer_mappings, public.promo_redemptions, public.promo_benefit_periods,
  public.donation_payout_batches, public.donation_accruals, public.donation_adjustments from anon;

-- Every P17 write goes through the API (service role) after domain validation.
revoke insert, update, delete on public.schools, public.school_referral_codes, public.school_admins,
  public.family_school_attributions, public.family_school_designations,
  public.promo_campaign_templates, public.promo_campaigns, public.promo_codes,
  public.provider_offer_mappings, public.promo_redemptions, public.promo_benefit_periods,
  public.donation_payout_batches, public.donation_accruals, public.donation_adjustments
  from authenticated;

-- Parents choose from active schools; names only (no payout details exist in this table).
create policy schools_active_read on public.schools
  for select to authenticated using (status = 'active' or app.is_owner_admin() or app.is_school_admin(id));

create policy school_admins_self_read on public.school_admins
  for select to authenticated using (user_id = app.current_user_id() or app.is_owner_admin());

create policy attributions_member_read on public.family_school_attributions
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

create policy designations_member_read on public.family_school_designations
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

-- Codes, campaigns and templates are never listable by families (prevents code enumeration).
create policy templates_admin_read on public.promo_campaign_templates
  for select to authenticated using (app.is_owner_admin());
create policy campaigns_admin_read on public.promo_campaigns
  for select to authenticated using (app.is_owner_admin());
create policy codes_admin_read on public.promo_codes
  for select to authenticated using (app.is_owner_admin());
create policy offer_mappings_admin_read on public.provider_offer_mappings
  for select to authenticated using (app.is_owner_admin());
create policy referral_codes_admin_read on public.school_referral_codes
  for select to authenticated using (app.is_owner_admin());

create policy redemptions_member_read on public.promo_redemptions
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());
create policy benefit_periods_member_read on public.promo_benefit_periods
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

create policy accruals_member_read on public.donation_accruals
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());
create policy adjustments_admin_read on public.donation_adjustments
  for select to authenticated using (app.is_owner_admin());
create policy payout_batches_admin_read on public.donation_payout_batches
  for select to authenticated using (app.is_owner_admin());

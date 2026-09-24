-- 0200_billing.sql
-- Store product → paid-slot mappings, provider webhook events, the normalized family entitlement
-- ledger, paid capacity and child slot assignments, capacity changes, provider billing periods
-- (inputs to P17 donation eligibility) and AI usage/quota ledgers. Depends on 0001.
-- See docs/Architecture.md §5 and spec P11/P12/F4.

-- ---------------------------------------------------------------------------------------------
-- Store catalog mapping (spec P11: capacity comes from verified product IDs, never the client)
-- ---------------------------------------------------------------------------------------------

create table public.store_product_mappings (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  product_id text not null check (char_length(product_id) between 1 and 200),
  -- Google Play base plan id; empty string when not applicable.
  base_plan_id text not null default '',
  environment text not null check (environment in ('sandbox', 'production')),
  paid_slots smallint not null check (paid_slots between 1 and 12),
  -- Actual price configured in the store catalog, recorded only after verification. Release
  -- readiness blocks a tier whose store price differs from the approved price (no silent rounding).
  store_price_cents integer check (store_price_cents > 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  price_verified_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (channel, product_id, base_plan_id, environment)
);

-- ---------------------------------------------------------------------------------------------
-- Provider events (RevenueCat, Stripe): dedupe + audit. Raw payloads are NOT stored (they can
-- contain emails); keep a digest and the normalized fields needed for reconciliation.
-- ---------------------------------------------------------------------------------------------

create table public.billing_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('revenuecat', 'stripe')),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  family_id uuid references public.families (id),
  event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed')),
  error_code text,
  unique (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------------------------
-- Normalized entitlement ledger: the single source of truth for paid access (spec E2)
-- ---------------------------------------------------------------------------------------------

create table public.family_entitlements (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  provider_subscription_id text not null,
  product_id text not null,
  paid_slots smallint not null check (paid_slots between 0 and 12),
  status text not null check (status in (
    'pending', 'active', 'grace_period', 'billing_retry', 'cancelled_active',
    'expired', 'revoked', 'refunded')),
  environment text not null check (environment in ('sandbox', 'production')),
  period_start timestamptz,
  period_end timestamptz,
  auto_renew boolean not null default true,
  pending_product_id text,
  pending_effective_at timestamptz,
  -- Out-of-order protection: reconciliation ignores snapshots older than this.
  provider_updated_at timestamptz not null,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, provider_subscription_id),
  check (period_end is null or period_start is null or period_end > period_start)
);

create index family_entitlements_family on public.family_entitlements (family_id);
create trigger family_entitlements_touch before update on public.family_entitlements
  for each row execute function app.touch_updated_at();

-- Materialized capacity computed by the API from family_entitlements (max, never a sum).
create table public.family_capacity (
  family_id uuid primary key references public.families (id),
  paid_slots smallint not null default 0 check (paid_slots between 0 and 12),
  managing_channel text check (managing_channel in ('app_store', 'play_store', 'stripe')),
  conflict text check (conflict in ('duplicate_active_subscriptions')),
  pending_target_slots smallint check (pending_target_slots between 0 and 12),
  pending_effective_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger family_capacity_touch before update on public.family_capacity
  for each row execute function app.touch_updated_at();

-- A child holds at most one open slot; open slots never exceed verified paid capacity.
create table public.child_slot_assignments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text check (release_reason in ('downgrade', 'archived', 'expired', 'reassigned')),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((released_at is null) = (release_reason is null))
);

create unique index child_slot_assignments_one_open
  on public.child_slot_assignments (child_id) where released_at is null;

create or replace function app.enforce_slot_capacity() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  capacity smallint;
  open_count integer;
begin
  if new.released_at is not null then
    return new;
  end if;
  -- Serialize concurrent assignments for one family (two guardians, two devices).
  perform 1 from public.families where id = new.family_id for update;
  select coalesce((select paid_slots from public.family_capacity where family_id = new.family_id), 0)
    into capacity;
  select count(*) into open_count
    from public.child_slot_assignments
   where family_id = new.family_id and released_at is null and id <> new.id;
  if open_count + 1 > capacity then
    raise exception 'paid capacity % exhausted for family %', capacity, new.family_id
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger child_slot_assignments_capacity
  before insert or update of released_at on public.child_slot_assignments
  for each row execute function app.enforce_slot_capacity();

create table public.capacity_changes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  requested_by uuid not null references auth.users (id),
  kind text not null check (kind in ('upgrade', 'downgrade')),
  from_slots smallint not null check (from_slots between 0 and 12),
  to_slots smallint not null check (to_slots between 0 and 12),
  keep_child_ids uuid[] not null default '{}',
  status text not null default 'pending_purchase'
    check (status in ('pending_purchase', 'scheduled', 'applied', 'cancelled', 'failed')),
  provider_effective_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_slots <> to_slots)
);

create index capacity_changes_family on public.capacity_changes (family_id, created_at desc);
create trigger capacity_changes_touch before update on public.capacity_changes
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Provider billing periods (normalized invoices/transactions). Period boundaries come from the
-- provider. P17 donation eligibility is evaluated from these rows.
-- ---------------------------------------------------------------------------------------------

create table public.billing_periods (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  provider_period_id text not null check (char_length(provider_period_id) between 1 and 200),
  kind text not null check (kind in ('subscription_period', 'proration', 'addon', 'tax_only')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  paid_slots smallint not null check (paid_slots between 1 and 12),
  regular_amount_cents integer not null check (regular_amount_cents >= 0),
  charged_amount_cents integer not null check (charged_amount_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  discount_sources text[] not null default '{}'
    check (discount_sources <@ array['promo_code', 'promotional_credit', 'introductory_offer', 'other_discount']),
  settlement text not null check (settlement in (
    'pending', 'settled', 'failed', 'refunded', 'partially_refunded', 'chargeback')),
  settled_at timestamptz,
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, provider_period_id),
  check (period_end > period_start),
  check (settlement <> 'settled' or settled_at is not null)
);

create index billing_periods_family on public.billing_periods (family_id, period_start desc);
create trigger billing_periods_touch before update on public.billing_periods
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Usage allowances (reservations include in-flight work) and AI usage metering (spec P11/P12/F3)
-- ---------------------------------------------------------------------------------------------

create table public.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  period_key text not null check (char_length(period_key) between 1 and 80),
  units integer not null check (units > 0),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  release_reason text check (release_reason in ('unreadable', 'cancelled', 'failed_final')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((status = 'released') = (release_reason is not null))
);

create index usage_reservations_period on public.usage_reservations (family_id, period_key);
create trigger usage_reservations_touch before update on public.usage_reservations
  for each row execute function app.touch_updated_at();

-- Terminal usage states cannot change (commit after release, re-release, etc.).
create or replace function app.guard_usage_transition() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'reserved' and new.status is distinct from old.status then
    raise exception 'usage reservation % is % and cannot become %', old.id, old.status, new.status
      using errcode = 'P0001';
  end if;
  if new.units <> old.units or new.child_id <> old.child_id or new.family_id <> old.family_id
     or new.period_key <> old.period_key or new.idempotency_key <> old.idempotency_key then
    raise exception 'usage reservation facts are immutable' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger usage_reservations_transition before update on public.usage_reservations
  for each row execute function app.guard_usage_transition();

create table public.ai_usage_events (
  id bigint generated always as identity primary key,
  family_id uuid references public.families (id),
  child_id uuid,
  stage text not null check (stage in (
    'extraction', 'grading', 'verification', 'coaching', 'followup', 'daily_set',
    'thursday_bundle', 'semantic_check', 'escalation', 'adult_summary', 'resource_ranking')),
  model_id text not null,
  prompt_version text not null,
  attempt smallint not null default 1 check (attempt >= 1),
  status text not null check (status in ('succeeded', 'failed', 'timeout', 'rejected_by_validation')),
  input_tokens integer not null check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  cost_micros bigint not null check (cost_micros >= 0),
  rate_table_version text not null,
  created_at timestamptz not null default now(),
  check (cached_input_tokens <= input_tokens)
);

create index ai_usage_events_family on public.ai_usage_events (family_id, created_at desc);
create trigger ai_usage_events_append_only before update or delete on public.ai_usage_events
  for each row execute function app.prevent_mutation();

create table public.spend_budgets (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'global' check (scope in ('global')),
  period_key text not null,
  -- Owner-supplied cap. There is intentionally no default (spec F4: never invent the owner's cap).
  budget_micros bigint not null check (budget_micros > 0),
  alert_thresholds_percent smallint[] not null default '{50,80,100}',
  alerted_thresholds_percent smallint[] not null default '{}',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (scope, period_key)
);

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.store_product_mappings enable row level security;
alter table public.billing_provider_events enable row level security;
alter table public.family_entitlements enable row level security;
alter table public.family_capacity enable row level security;
alter table public.child_slot_assignments enable row level security;
alter table public.capacity_changes enable row level security;
alter table public.billing_periods enable row level security;
alter table public.usage_reservations enable row level security;
alter table public.ai_usage_events enable row level security;
alter table public.spend_budgets enable row level security;

revoke all on public.store_product_mappings, public.billing_provider_events,
  public.family_entitlements, public.family_capacity, public.child_slot_assignments,
  public.capacity_changes, public.billing_periods, public.usage_reservations,
  public.ai_usage_events, public.spend_budgets from anon;

-- All billing writes happen in the API (service role) after provider verification.
revoke insert, update, delete on public.store_product_mappings, public.billing_provider_events,
  public.family_entitlements, public.family_capacity, public.child_slot_assignments,
  public.capacity_changes, public.billing_periods, public.usage_reservations,
  public.ai_usage_events, public.spend_budgets from authenticated;

create policy store_product_mappings_read on public.store_product_mappings
  for select to authenticated using (active);

create policy billing_provider_events_admin_read on public.billing_provider_events
  for select to authenticated using (app.is_owner_admin());

create policy family_entitlements_member_read on public.family_entitlements
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

create policy family_capacity_member_read on public.family_capacity
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

create policy child_slot_assignments_member_read on public.child_slot_assignments
  for select to authenticated using (app.is_family_member(family_id));

create policy capacity_changes_member_read on public.capacity_changes
  for select to authenticated using (app.is_family_member(family_id));

create policy billing_periods_member_read on public.billing_periods
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());

create policy usage_reservations_member_read on public.usage_reservations
  for select to authenticated using (app.is_family_member(family_id));

-- Per-request AI cost detail is owner-only; parents see aggregates through the API.
create policy ai_usage_events_admin_read on public.ai_usage_events
  for select to authenticated using (app.is_owner_admin());

create policy spend_budgets_admin_read on public.spend_budgets
  for select to authenticated using (app.is_owner_admin());

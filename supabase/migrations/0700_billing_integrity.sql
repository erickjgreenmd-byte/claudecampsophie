-- 0700_billing_integrity.sql
-- RV-lead-billing-p17-3: a refund or chargeback can reach us before the charge it reverses (provider
-- retries run on independent schedules). It is parked here and applied the moment the billing
-- period is recorded, so a refunded month never accrues a school donation. Service-role only.

create table public.pending_refunds (
  family_id uuid not null references public.families (id),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  provider_period_id text not null check (char_length(provider_period_id) between 1 and 200),
  kind text not null check (kind in ('refund', 'partial_refund', 'chargeback')),
  refunded_cents integer check (refunded_cents >= 0),
  created_at timestamptz not null default now(),
  primary key (channel, provider_period_id)
);

alter table public.pending_refunds enable row level security;
revoke all on public.pending_refunds from anon, authenticated, pl_child;

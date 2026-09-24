-- 0730_school_report_accuracy.sql
-- Spec P17: "The administrator can see amount owed versus actually paid; schools see only
-- authorized aggregate figures." AC_PROMO_10, AC_PROMO_12. Redefines the two school report
-- functions from 0690 (same signatures, grants and authorization) to fix two accuracy defects and
-- to keep complementary suppression (RV-donations-4, RV-lead-billing-p17-9) sound for the
-- corrected figures.
--
-- 1. paid_cents is what the school was actually paid for the month: the month's accruals in a paid
--    batch PLUS the month's adjustments (refund/chargeback reversals, won-dispute reinstatements)
--    in a paid batch. A reversal of an already-paid accrual is netted in a LATER batch
--    (packages/domain/src/donations/adjustments.ts), so before this fix the month kept showing the
--    reversed dollar as paid. A batch counts as paid when its status is 'paid' or 'adjusted' (the
--    payout state machine only reaches 'adjusted' from 'paid'); before, 'adjusted' batches dropped
--    out of paid_cents.
-- 2. school_month_report_counts: a period counts only while its payment stands: 'settled', or
--    'partially_refunded' with part of the charge kept. Fully refunded and charged-back periods no
--    longer make a family active (or paying). "Paying" means a positive amount kept after refunds.
--
-- Complementary suppression, one rule for both functions: a school viewer is shown a group of
-- figures only if no figure, and no difference between two figures, is 1-4 families (100-499 cents;
-- every family is worth exactly 100 cents, so amounts are family counts). The report checks its
-- own figures (signups, eligible, accrued, paid). The counts function checks its three counts
-- against those figures too, because a viewer reads both results side by side (e.g. active families
-- minus accruing families). The owner (exact) always sees the real figures.

-- Exact donation figures for one school-month. Internal: no authorization of its own, so no client
-- role may execute it; only the SECURITY DEFINER report functions below call it.
create or replace function app.school_month_donation_figures(
  p_school uuid,
  p_month text,
  out signups bigint,
  out eligible bigint,
  out accrued_cents bigint,
  out paid_cents bigint
)
language sql stable
set search_path = ''
as $$
  with accruals as (
    select d.id, d.family_id, d.amount_cents,
           coalesce(b.status in ('paid', 'adjusted'), false) as paid
      from public.donation_accruals d
      left join public.donation_payout_batches b on b.id = d.payout_batch_id
     where d.school_id = p_school and d.donation_month = p_month
  ), adjustments as (
    select j.amount_cents, coalesce(b.status in ('paid', 'adjusted'), false) as paid
      from public.donation_adjustments j
      join accruals a on a.id = j.accrual_id
      left join public.donation_payout_batches b on b.id = j.payout_batch_id
  )
  select
    (select count(distinct t.family_id) from public.family_school_attributions t
      where t.school_id = p_school and t.superseded_at is null),
    (select count(distinct a.family_id) from accruals a),
    (select coalesce(sum(a.amount_cents), 0) from accruals a)
      + (select coalesce(sum(j.amount_cents), 0) from adjustments j),
    (select coalesce(sum(a.amount_cents) filter (where a.paid), 0) from accruals a)
      + (select coalesce(sum(j.amount_cents) filter (where j.paid), 0) from adjustments j)
$$;

revoke execute on function app.school_month_donation_figures(uuid, text) from public, anon, authenticated, pl_child;

-- True when any figure, or any difference between two figures, is a 1-4 family group. Figures are
-- in cents (a family count times 100, or an amount), so a small group is 1-499 cents.
create or replace function app.reveals_small_group(p_cents bigint[])
returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (
    select 1
      from unnest(p_cents || 0::bigint) x
     cross join unnest(p_cents || 0::bigint) y
     where abs(x - y) between 1 and 499
  )
$$;

revoke execute on function app.reveals_small_group(bigint[]) from public, anon, authenticated, pl_child;

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
  f record;
  exact boolean := app.is_owner_admin();
  hide_signups boolean;
  hide_eligible boolean;
begin
  if not (exact or app.is_school_admin(p_school)) then
    raise exception 'not authorized for this school' using errcode = '42501';
  end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  select * into f from app.school_month_donation_figures(p_school, p_month);
  hide_signups := not exact and f.signups between 1 and 4;
  -- Covers everything 0690 checked (eligible 1-4, signups - eligible, eligible*100 - accrued,
  -- eligible*100 - paid) plus accrued and paid themselves, accrued - paid, and signups against
  -- the amounts.
  hide_eligible := not exact and app.reveals_small_group(
    array[f.signups * 100, f.eligible * 100, f.accrued_cents, f.paid_cents]);
  return query select
    p_school,
    p_month,
    case when hide_signups then '<5' else f.signups::text end,
    case when hide_eligible then '<5' else f.eligible::text end,
    case when hide_eligible then null else f.accrued_cents end,
    case when hide_eligible then null else f.paid_cents end;
end
$$;

revoke execute on function public.school_month_report(uuid, text) from public, anon;
grant execute on function public.school_month_report(uuid, text) to authenticated;

create or replace function public.school_month_report_counts(p_school uuid, p_month text, p_zone text default 'UTC')
returns table (
  school_id uuid,
  donation_month text,
  active_families text,
  positive_paying_families text,
  fully_discounted_families text
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  exact boolean := app.is_owner_admin();
  month_start date;
  window_start timestamptz;
  window_end timestamptz;
  active bigint;
  paying bigint;
  discounted bigint;
  f record;
  hide boolean;
begin
  if not (exact or app.is_school_admin(p_school)) then
    raise exception 'not authorized for this school' using errcode = '42501';
  end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_zone) then
    raise exception 'invalid time zone' using errcode = '22023';
  end if;
  month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  window_start := (month_start::timestamp) at time zone p_zone;
  window_end := ((month_start + interval '1 month')::timestamp) at time zone p_zone;

  with designated as (
    select distinct d.family_id
      from public.family_school_designations d
     where d.school_id = p_school
       and d.effective_from <= month_start
       and (d.effective_to is null or d.effective_to > month_start)
  ), standing as (
    -- Periods starting in the month whose payment stands; refunded and charged-back ones do not.
    select p.family_id, p.charged_amount_cents, p.refunded_cents, p.discount_sources
      from public.billing_periods p
      join designated g on g.family_id = p.family_id
     where p.kind = 'subscription_period'
       and p.period_start >= window_start and p.period_start < window_end
       and (p.settlement = 'settled'
            or (p.settlement = 'partially_refunded' and p.refunded_cents < p.charged_amount_cents))
  ), per_family as (
    select family_id,
           bool_or(charged_amount_cents - refunded_cents > 0) as paid_something,
           bool_and(charged_amount_cents = 0 and 'promo_code' = any(discount_sources)) as fully_discounted
      from standing group by family_id
  )
  select count(*), count(*) filter (where paid_something), count(*) filter (where fully_discounted)
    into active, paying, discounted
    from per_family;

  select * into f from app.school_month_donation_figures(p_school, p_month);
  hide := not exact and app.reveals_small_group(
    array[active * 100, paying * 100, discounted * 100,
          f.signups * 100, f.eligible * 100, f.accrued_cents, f.paid_cents]);
  return query select
    p_school,
    p_month,
    case when hide then '<5' else active::text end,
    case when hide then '<5' else paying::text end,
    case when hide then '<5' else discounted::text end;
end
$$;

revoke execute on function public.school_month_report_counts(uuid, text, text) from public, anon;
grant execute on function public.school_month_report_counts(uuid, text, text) to authenticated;

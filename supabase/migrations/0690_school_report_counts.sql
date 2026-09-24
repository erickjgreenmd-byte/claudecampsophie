-- 0690_school_report_counts.sql
-- AC_PROMO_10: the monthly school report also shows how many designated families were active,
-- paid a positive amount, or were fully discounted that month. Same authorization and the same
-- small-cohort suppression as public.school_month_report (school viewers see "<5").
--
-- school_month_report is redefined below with the same complementary suppression.
--
-- A family counts for a school-month when its designation covers that program month. "Active" means
-- a subscription period starting in the month that settled (or refunded later); "paying" means at
-- least one such period charged more than $0; "fully discounted" means every such period charged $0
-- because of a promo code.

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
  eligible bigint;
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
  ), periods as (
    select p.family_id, p.charged_amount_cents, p.discount_sources
      from public.billing_periods p
      join designated g on g.family_id = p.family_id
     where p.kind = 'subscription_period'
       and p.period_start >= window_start and p.period_start < window_end
       and p.settlement in ('settled', 'refunded', 'partially_refunded', 'chargeback')
  ), per_family as (
    select family_id,
           bool_or(charged_amount_cents > 0) as paid_something,
           bool_and(charged_amount_cents = 0 and 'promo_code' = any(discount_sources)) as fully_discounted
      from periods group by family_id
  )
  select count(*), count(*) filter (where paid_something), count(*) filter (where fully_discounted)
    into active, paying, discounted
    from per_family;

  select count(distinct x.family_id) into eligible
    from public.donation_accruals x where x.school_id = p_school and x.donation_month = p_month;

  -- Complementary suppression (RV-donations-4): a school viewer must not recover a small group by
  -- subtracting published numbers, so if any count or any difference between the published counts
  -- (including this month's donation-eligible count from school_month_report) is 1-4, every count
  -- here is withheld. The owner (exact) always sees the real figures.
  hide := not exact and exists (
    select 1 from unnest(array[active, paying, discounted, eligible]) x
     cross join unnest(array[active, paying, discounted, eligible, 0::bigint]) y
     where abs(x - y) between 1 and 4
  );
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

-- Redefinition of 0300's report: the donation-eligible count (and the amounts, which reveal it at
-- $1 per family) is withheld from school viewers when it, or its difference from the signup count,
-- is 1-4, so subtraction cannot recover a small group (RV-donations-4).
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
  hide_signups boolean;
  hide_eligible boolean;
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
  hide_signups := not exact and signups between 1 and 4;
  hide_eligible := not exact and (eligible between 1 and 4 or abs(signups - eligible) between 1 and 4);
  return query select
    p_school,
    p_month,
    case when hide_signups then '<5' else signups::text end,
    case when hide_eligible then '<5' else eligible::text end,
    case when hide_eligible then null else accrued end,
    case when hide_eligible then null else paid end;
end
$$;

revoke execute on function public.school_month_report(uuid, text) from public, anon;
grant execute on function public.school_month_report(uuid, text) to authenticated;

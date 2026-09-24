-- 0690_school_report_counts.sql
-- AC_PROMO_10: the monthly school report also shows how many designated families were active,
-- paid a positive amount, or were fully discounted that month. Same authorization and the same
-- small-cohort suppression as public.school_month_report (school viewers see "<5").
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

  return query select
    p_school,
    p_month,
    case when exact or active = 0 or active >= 5 then active::text else '<5' end,
    case when exact or paying = 0 or paying >= 5 then paying::text else '<5' end,
    case when exact or discounted = 0 or discounted >= 5 then discounted::text else '<5' end;
end
$$;

revoke execute on function public.school_month_report_counts(uuid, text, text) from public, anon;
grant execute on function public.school_month_report_counts(uuid, text, text) to authenticated;

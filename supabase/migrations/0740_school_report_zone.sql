-- 0740_school_report_zone.sql
-- Spec P17 "schools see only authorized aggregate figures"; AC_PROMO_10 (BUG-074).
--
-- school_month_report_counts took a caller-chosen time zone for the month window. A school admin
-- calling the RPC directly (it is granted to authenticated) could ask for the same month under
-- two zones: families whose period started inside the offset band then appear as the difference
-- between two results, which suppression inside one call cannot see (a group of 1-4 families).
--
-- The program calendar zone is API configuration (PROGRAM_TIMEZONE). The API states it for the
-- report transaction in pencillift.program_zone, the same pattern as pencillift.request_now; a
-- client cannot set a pencillift.* setting through the Data API. A school viewer's call must use
-- exactly that zone, so a direct client call is refused. The owner (exact figures) may pass any
-- zone. Same signature, grants, authorization and suppression as 0730.
--
-- Today the only caller that states the zone is the owner-only GET /v1/admin/schools/:id/report;
-- no API route serves school viewers yet, so they cannot read these counts at all (LRD-6). A
-- school-facing report route must state the zone the same way; supabase/tests/school_report.test.ts
-- states it itself to stand in for that route.

-- The zone the API stated for this transaction, or null when none was stated.
create or replace function app.program_calendar_zone() returns text
language sql stable
set search_path = ''
as $$
  select nullif(current_setting('pencillift.program_zone', true), '')
$$;

revoke execute on function app.program_calendar_zone() from public, anon, authenticated, pl_child;

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
  -- A school viewer reads the counts only in the program calendar zone the API stated for this
  -- transaction; a direct client call (no stated zone) or any other zone is refused.
  if not exact and p_zone is distinct from app.program_calendar_zone() then
    raise exception 'school reports use the program calendar zone' using errcode = '42501';
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

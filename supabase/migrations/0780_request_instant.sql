-- 0780_request_instant.sql
-- CLAUDE.md "time is UTC instants ... domain code takes now as input" (BUG-090).
--
-- Jobs enqueued inside the database (public.request_deletion, app.inactivity_delete_family) took
-- their run_after from the column default now(), while the dispatcher decides what is due by the
-- application's clock. The two agree in production only as far as the Worker and database clocks
-- agree, and a pinned test clock never saw those jobs as due once real time passed it.
--
-- run_after now defaults to the request instant the API states for the transaction
-- (pencillift.request_now, the setting 0650 introduced for child release times), else now().
-- Clients cannot set a pencillift.* setting through the Data API, so a direct call still uses the
-- database clock. The API also passes run_after explicitly wherever it inserts a job itself.

create or replace function app.request_instant() returns timestamptz
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('pencillift.request_now', true), '')::timestamptz, now())
$$;

revoke execute on function app.request_instant() from public, anon;
grant execute on function app.request_instant() to authenticated, service_role, pl_child;

alter table public.jobs alter column run_after set default app.request_instant();

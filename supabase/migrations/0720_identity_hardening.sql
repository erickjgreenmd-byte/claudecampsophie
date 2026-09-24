-- 0720_identity_hardening.sql
-- Identity/access review fixes (RV-lead-identity-access-6/7/9 and review notes a, d, e).
--   1. One active family per adult, enforced by the schema (create_family, invitation acceptance,
--      direct PostgREST rpc and every retry).
--   2. families.timezone must be a real IANA zone on every write path (API, rpc, PostgREST).
--   3. A child has at most one live pairing code, and a child that stops being active has none.
--   4. Rate-limit buckets know when they expire and clean themselves up; a shared failure budget
--      is reserved before an attempt runs and paused only for the sites that spent it.
--   5. A Supabase auth session that has been signed out (row deleted) no longer authenticates the
--      API and its adult step-up unlocks are revoked.

-- ---------------------------------------------------------------------------------------------
-- 1. One active family per adult (RV-lead-identity-access-9, RV-family-2)
-- ---------------------------------------------------------------------------------------------

-- The check in create_family was an unlocked EXISTS, so two overlapping calls both passed it.
-- This index is the guarantee; the advisory lock below only turns the race into the friendly error.
create unique index family_memberships_one_active_family_per_user
  on public.family_memberships (user_id) where status = 'active';

create or replace function public.create_family(p_display_name text, p_timezone text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := app.current_user_id();
  new_family uuid;
begin
  if uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null) then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  -- Same per-adult lock as guardian invitation acceptance (apps/api/src/routes/guardians.ts), so
  -- concurrent create/accept calls by one adult run one at a time and the loser sees the winner.
  perform pg_advisory_xact_lock(hashtextextended('adult-membership:' || uid::text, 0));
  if exists (select 1 from public.family_memberships m where m.user_id = uid and m.status = 'active') then
    raise exception 'adult already belongs to a family' using errcode = 'P0001';
  end if;
  insert into public.families (display_name, timezone, created_by)
    values (p_display_name, p_timezone, uid)
    returning id into new_family;
  insert into public.family_memberships (family_id, user_id, role)
    values (new_family, uid, 'owner');
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (new_family, uid, 'parent', 'family.created', 'family', new_family::text);
  return new_family;
end
$$;

revoke execute on function public.create_family(text, text) from public, anon;
grant execute on function public.create_family(text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. families.timezone is an IANA zone on every path (review note d)
-- ---------------------------------------------------------------------------------------------

-- pg_timezone_names reads the zone files on every call (~15 ms), so known names are cached here;
-- the live view is still consulted for a name added by a newer tz database.
create table private.known_time_zones (
  name text primary key
);
insert into private.known_time_zones (name)
  select name from pg_catalog.pg_timezone_names
  on conflict (name) do nothing;

create or replace function app.families_require_iana_timezone() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.timezone is null
     or not (
       exists (select 1 from private.known_time_zones z where z.name = new.timezone)
       or exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone)
     ) then
    raise exception 'time zone is not a known IANA zone'
      using errcode = '23514', constraint = 'families_timezone_iana';
  end if;
  return new;
end
$$;

revoke execute on function app.families_require_iana_timezone() from public, anon, authenticated, pl_child;

create trigger families_timezone_iana
  before insert or update of timezone on public.families
  for each row execute function app.families_require_iana_timezone();

-- ---------------------------------------------------------------------------------------------
-- 3. Pairing codes: one live code per child, none for a child that is not active
--    (RV-lead-identity-access-7, review note e)
-- ---------------------------------------------------------------------------------------------

-- Existing duplicates (older unconsumed codes of one child) end before the index is built.
update private.child_pairing_codes p
   set consumed_at = now()
 where p.consumed_at is null
   and exists (
     select 1 from private.child_pairing_codes q
      where q.child_id = p.child_id and q.consumed_at is null
        and (q.created_at, q.id) > (p.created_at, p.id)
   );

create unique index child_pairing_codes_one_live_per_child
  on private.child_pairing_codes (child_id) where consumed_at is null;

-- Every new code serializes on its child row: two overlapping "new code" requests leave exactly one
-- live code, and a code can never be issued for a child that is not (or no longer) active.
create or replace function app.child_pairing_codes_before_insert() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  child_status text;
begin
  select c.status into child_status
    from public.child_profiles c
    join public.families f on f.id = c.family_id
   where c.id = new.child_id and c.family_id = new.family_id and f.deleted_at is null
   for no key update of c;
  if child_status is distinct from 'active' then
    raise exception 'pairing codes are only issued for active children'
      using errcode = '23514', constraint = 'child_pairing_codes_child_active';
  end if;
  update private.child_pairing_codes
     set consumed_at = now()
   where child_id = new.child_id and consumed_at is null;
  return new;
end
$$;

revoke execute on function app.child_pairing_codes_before_insert() from public, anon, authenticated, pl_child;

create trigger child_pairing_codes_serialize
  before insert on private.child_pairing_codes
  for each row execute function app.child_pairing_codes_before_insert();

-- Archive (or any other path that ends a child's active status) ends every unredeemed code, so a
-- code issued before the archive cannot pair a device after a later re-activation.
create or replace function app.child_profiles_end_pairing_codes() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update private.child_pairing_codes
     set consumed_at = now()
   where child_id = new.id and consumed_at is null;
  return null;
end
$$;

revoke execute on function app.child_profiles_end_pairing_codes() from public, anon, authenticated, pl_child;

create trigger child_profiles_end_pairing_codes
  after update of status on public.child_profiles
  for each row
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function app.child_profiles_end_pairing_codes();

-- ---------------------------------------------------------------------------------------------
-- 4. Rate-limit buckets (RV-lead-identity-access-6)
-- ---------------------------------------------------------------------------------------------

alter table private.rate_limit_buckets add column expires_at timestamptz;
update private.rate_limit_buckets set expires_at = window_start + interval '1 day' where expires_at is null;

create index rate_limit_buckets_expiry on private.rate_limit_buckets (expires_at);

-- Deletes buckets whose window ended at or before p_cutoff, oldest first. Rows another transaction
-- holds are skipped, so concurrent callers never wait on (or deadlock over) each other's rows.
create or replace function app.purge_expired_rate_limit_buckets(p_cutoff timestamptz, p_max integer default 10000)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with doomed as (
    select bucket_key from private.rate_limit_buckets
     where expires_at <= p_cutoff
     order by expires_at
     limit greatest(p_max, 0)
     for update skip locked
  )
  delete from private.rate_limit_buckets b using doomed where b.bucket_key = doomed.bucket_key;
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke execute on function app.purge_expired_rate_limit_buckets(timestamptz, integer) from public, anon, authenticated, pl_child;
grant execute on function app.purge_expired_rate_limit_buckets(timestamptz, integer) to service_role;

-- Same contract as 0610; additionally records when the bucket's window ends, and clears a few
-- buckets whose window ended over a day ago. Every new client network adds a bucket, so the table
-- stays bounded even if no scheduled purge runs; the day of slack leaves any bucket a slightly
-- lagging clock could still be counting in alone.
create or replace function app.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer, p_now timestamptz)
returns table (allowed boolean, hits integer, retry_after_seconds integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  window_begin timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  window_end timestamptz := window_begin + make_interval(secs => p_window_seconds);
  current_hits integer;
begin
  insert into private.rate_limit_buckets as b (bucket_key, window_start, hits, updated_at, expires_at)
    values (p_key, window_begin, 1, p_now, window_end)
    on conflict (bucket_key) do update
      set hits = case when b.window_start = excluded.window_start then b.hits + 1 else 1 end,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
    returning b.hits into current_hits;
  perform app.purge_expired_rate_limit_buckets(p_now - interval '1 day', 8);
  return query select
    current_hits <= p_limit,
    current_hits,
    greatest(0, ceil(extract(epoch from (window_end - p_now)))::integer);
end
$$;

revoke execute on function app.rate_limit_hit(text, integer, integer, timestamptz) from public, anon, authenticated, pl_child;
grant execute on function app.rate_limit_hit(text, integer, integer, timestamptz) to service_role;

-- Gives back one hit of p_key in the window of p_now (never below zero; a later window is untouched).
create or replace function app.rate_limit_release(p_key text, p_window_seconds integer, p_now timestamptz)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  window_begin timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
begin
  update private.rate_limit_buckets b
     set hits = greatest(b.hits - 1, 0)
   where b.bucket_key = p_key and b.window_start = window_begin;
end
$$;

revoke execute on function app.rate_limit_release(text, integer, timestamptz) from public, anon, authenticated, pl_child;
grant execute on function app.rate_limit_release(text, integer, timestamptz) to service_role;

-- A failure budget shared by every client (e.g. wrong pairing codes across the service).
--   * One unit is reserved BEFORE the attempt runs, so attempts in flight count (AC_SECURITY_06);
--     the caller gives it back with app.rate_limit_release when the attempt succeeds.
--   * The shared row is always locked first, so concurrent reservations run one at a time.
--   * Once the shared budget is used up, a client key (a network site) with no failure and no
--     attempt in flight in this window may still make one attempt; every other client is refused
--     and keeps nothing. Spending the budget therefore pauses the spender's own sites, not every
--     family (checker follow-up on RV-lead-identity-access-6).
create or replace function app.rate_limit_reserve_shared(
  p_shared_key text, p_client_key text, p_limit integer, p_window_seconds integer, p_now timestamptz)
returns table (allowed boolean, exhausted boolean, retry_after_seconds integer)
language plpgsql security definer
set search_path = ''
as $$
declare
  window_begin timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
  window_end timestamptz := window_begin + make_interval(secs => p_window_seconds);
  shared_hits integer;
  client_hits integer;
begin
  select h.hits into shared_hits from app.rate_limit_hit(p_shared_key, p_limit, p_window_seconds, p_now) h;
  select h.hits into client_hits from app.rate_limit_hit(p_client_key, p_limit, p_window_seconds, p_now) h;
  if shared_hits <= p_limit then
    return query select true, false, 0;
  elsif client_hits = 1 then
    return query select true, true, 0;
  else
    perform app.rate_limit_release(p_client_key, p_window_seconds, p_now);
    perform app.rate_limit_release(p_shared_key, p_window_seconds, p_now);
    return query select false, true,
      greatest(1, ceil(extract(epoch from (window_end - p_now)))::integer);
  end if;
end
$$;

revoke execute on function app.rate_limit_reserve_shared(text, text, integer, integer, timestamptz) from public, anon, authenticated, pl_child;
grant execute on function app.rate_limit_reserve_shared(text, text, integer, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Signed-out Supabase sessions stop working in the API (review note a, spec P3 logout)
-- ---------------------------------------------------------------------------------------------

-- Supabase Auth deletes the auth.sessions row on sign-out (local, global and "others") and when
-- it expires a session. A deleted row cannot be told apart from a session id that never existed,
-- so the deletion is recorded here. Kept longer than the longest access-token lifetime Supabase
-- allows (one week) and then purged by app.purge_ended_auth_sessions.
create table private.ended_auth_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  ended_at timestamptz not null default now()
);

create index ended_auth_sessions_ended_at on private.ended_auth_sessions (ended_at);

create or replace function app.auth_session_ended() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into private.ended_auth_sessions (session_id, user_id, ended_at)
    values (old.id, old.user_id, now())
    on conflict (session_id) do nothing;
  -- A step-up bound to the ended session must not outlive it (also closes the PostgREST path,
  -- whose step-up policies call app.has_recent_adult_unlock()).
  update private.adult_unlocks
     set revoked_at = now()
   where auth_session_id = old.id::text and revoked_at is null;
  -- Each sign-out also clears a few records past their retention, so the table stays bounded
  -- even if no scheduled purge runs.
  perform app.purge_ended_auth_sessions(8);
  return old;
end
$$;

revoke execute on function app.auth_session_ended() from public, anon, authenticated, pl_child;

create trigger pencillift_auth_session_ended
  after delete on auth.sessions
  for each row execute function app.auth_session_ended();

-- True while the Supabase session named by a verified access token may still be used:
--   * it was not signed out (no ended record);
--   * if its row exists it belongs to this adult and is not past its not_after time-box;
--   * if its row is gone while the adult still has other sessions, it was signed out.
-- Fails closed on anything that is not a UUID.
create or replace function app.auth_session_active(p_user uuid, p_session text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  sid uuid;
  owner_id uuid;
  expires timestamptz;
begin
  if p_user is null or p_session is null
     or p_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  sid := p_session::uuid;
  if exists (select 1 from private.ended_auth_sessions e where e.session_id = sid) then
    return false;
  end if;
  select s.user_id, s.not_after into owner_id, expires from auth.sessions s where s.id = sid;
  if found then
    return owner_id = p_user and (expires is null or expires > now());
  end if;
  return not exists (select 1 from auth.sessions s where s.user_id = p_user);
end
$$;

revoke execute on function app.auth_session_active(uuid, text) from public, anon, authenticated, pl_child;
grant execute on function app.auth_session_active(uuid, text) to service_role;

-- ended_at is written with the database clock, so it is aged with the database clock too (an
-- injected tick clock running ahead must never purge a record whose token can still be presented).
create or replace function app.purge_ended_auth_sessions(p_max integer default 10000)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with doomed as (
    select session_id from private.ended_auth_sessions
     where ended_at < now() - interval '8 days'
     order by ended_at
     limit greatest(p_max, 0)
     for update skip locked
  )
  delete from private.ended_auth_sessions e using doomed where e.session_id = doomed.session_id;
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke execute on function app.purge_ended_auth_sessions(integer) from public, anon, authenticated, pl_child;
grant execute on function app.purge_ended_auth_sessions(integer) to service_role;

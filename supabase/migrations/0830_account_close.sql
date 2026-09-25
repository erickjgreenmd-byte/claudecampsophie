-- 0830: account closure (Apple App Store 5.1.1(v), Google Play account-deletion policy): a parent
-- can delete their own sign-in from the app, not only the family's data.
--
-- What closes an account is Supabase Auth's SOFT delete of the auth user (Admin API
-- `DELETE /auth/v1/admin/users/{id}` with should_soft_delete: true; apps/api/src/providers/auth-admin.ts):
-- GoTrue keeps the auth.users row, sets deleted_at, replaces email and phone with hashes, empties the
-- metadata and ends every session. A HARD delete is impossible by design: about forty columns reference
-- auth.users without an ON DELETE action (grep -n "references auth.users" supabase/migrations/*.sql), so
-- the pseudonymous id stays referable from the security log, billing and consent records after the
-- person's sign-in is gone (tested in supabase/tests/account_close.test.ts).
--
--   1. jobs.kind gains 'account_close' (payload: the auth user id only; family_id stays null so the job
--      outlives the family tombstone and purge that precede it for a family owner).
--   2. app.auth_user_closed(uuid): true once the auth user is soft-deleted or gone. app.auth_session_active
--      (0720) and app.adult_auth_email (0660) are re-created to refuse a closed user: a Supabase access
--      token stays valid until it expires, so the API's live-session check (requireParent) is where a
--      closed user's token is refused, and no email is ever sent to the scrubbed address.
--   3. app.close_auth_user_locally(uuid): the labeled local double's emulation of the soft delete, for
--      development and test only (it refuses on a database marked staging or production).
--   4. The test shim's auth.users lacks GoTrue's deleted_at and phone columns; they are added only where
--      missing. On a hosted project auth.users belongs to Supabase Auth and already has them, so nothing
--      is altered there.

-- ---------------------------------------------------------------------------------------------
-- 4. GoTrue columns the local shim does not model (no-op on a hosted project)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'deleted_at') then
    alter table auth.users add column deleted_at timestamptz;
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'phone') then
    alter table auth.users add column phone text;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. The durable job that closes a family owner's sign-in after the purge
-- ---------------------------------------------------------------------------------------------

-- The 0790 list plus 'account_close' (payload: {"userId": <auth user id>}; no family, no child).
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'scan_process', 'daily_set_generate', 'thursday_review_generate', 'review_top_up',
  'promo_month_generate', 'promo_offer_provision', 'promo_reconcile', 'donation_accrue',
  'payout_prepare', 'entitlement_reconcile', 'retention_purge', 'deletion_purge',
  'notification_send', 'export_build', 'safety_flag_email', 'account_close'));

-- ---------------------------------------------------------------------------------------------
-- 2. A closed auth user is refused everywhere the API checks a parent
-- ---------------------------------------------------------------------------------------------

-- True once the auth user is soft-deleted (deleted_at) or its row is gone. Null is closed (fail closed).
create or replace function app.auth_user_closed(p_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is null
      or not exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null)
$$;

revoke execute on function app.auth_user_closed(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.auth_user_closed(uuid) to service_role;

-- 0720's rule, unchanged, behind one more check: a closed user's session is never active, however
-- long its access token still verifies. Supabase ends the sessions on a soft delete (recorded by
-- the 0720 trigger); the deleted_at check also covers a token minted before the sessions ended and a
-- user closed while the session table was not consulted (no sessions recorded at all).
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
  if app.auth_user_closed(p_user) then
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

-- 0660's lookup, minus closed users: GoTrue leaves a hash in the email column (marked confirmed), and
-- nothing may be sent to it. A closed user simply has no address (no row), which every caller already
-- treats as "no verified email".
create or replace function app.adult_auth_email(p_user uuid)
returns table (email text, email_verified boolean)
language sql stable security definer
set search_path = ''
as $$
  select u.email::text, u.email_confirmed_at is not null
    from auth.users u
   where u.id = p_user and u.deleted_at is null
$$;

revoke execute on function app.adult_auth_email(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.adult_auth_email(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The labeled local double (development and test only)
-- ---------------------------------------------------------------------------------------------

-- Emulates GoTrue's soft delete on the local auth.users: deleted_at set, email and phone replaced by
-- a pseudonym (the id is already pseudonymous), metadata emptied, every session ended the way a
-- Supabase sign-out is (delete from auth.sessions, so the 0720 trigger records each session and
-- revokes its step-ups) and any other step-up revoked. Returns true when it closed the user now,
-- false when the user was already closed or does not exist. Refused on a database marked staging or
-- production: a hosted project closes users through the Auth Admin API, never through this.
create or replace function app.close_auth_user_locally(p_user uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  if app.database_environment() in ('staging', 'production') then
    raise exception 'the local auth double is refused outside development and test'
      using errcode = '42501';
  end if;
  if p_user is null then
    return false;
  end if;
  update auth.users
     set deleted_at = now(),
         email = 'closed:' || p_user::text,
         phone = null,
         raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data = '{}'::jsonb
   where id = p_user and deleted_at is null;
  if not found then
    return false;
  end if;
  delete from auth.sessions where user_id = p_user;
  update private.adult_unlocks set revoked_at = now()
   where user_id = p_user and revoked_at is null;
  return true;
end
$$;

revoke execute on function app.close_auth_user_locally(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.close_auth_user_locally(uuid) to service_role;

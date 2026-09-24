-- 0001_core_identity.sql
-- Families, adult memberships and invitations, consent records, child profiles, child device
-- pairing/sessions, adult step-up unlocks, owner admins and the audit log. Defines the helper
-- functions every later RLS policy uses. See docs/Architecture.md §3–4.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;

create schema if not exists app;
create schema if not exists private;

-- `private` is never exposed through PostgREST and nobody but the owner/service role may touch it.
revoke all on schema private from public;
grant usage on schema private to service_role;

-- API-only role for paired child sessions. Never granted to the PostgREST authenticator.
-- Roles are cluster-wide, so tolerate an existing role (and concurrent creation).
do $$ begin create role pl_child nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;

grant usage on schema app to anon, authenticated, service_role, pl_child;
grant usage on schema public to pl_child;

-- ---------------------------------------------------------------------------------------------
-- Claim and principal helpers
-- ---------------------------------------------------------------------------------------------

create or replace function app.jwt_claims() returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- Adult user id; null for any principal that is not an authenticated adult.
create or replace function app.current_user_id() returns uuid
language sql stable
set search_path = ''
as $$
  select case
    when app.jwt_claims() ->> 'role' = 'authenticated'
      then nullif(app.jwt_claims() ->> 'sub', '')::uuid
  end
$$;

create or replace function app.prevent_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'table %.% is append-only; record an adjustment instead', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Families and adult membership
-- ---------------------------------------------------------------------------------------------

create table public.families (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 80),
  -- IANA zone used for daily practice, Thursday reviews and quiet hours. Validated by the API.
  timezone text not null default 'America/New_York' check (char_length(timezone) between 1 and 64),
  -- Opaque server-mapped billing identity: RevenueCat appUserID and Stripe customer metadata.
  billing_ref text not null unique default ('fam_' || encode(gen_random_bytes(12), 'hex')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deletion_requested_at timestamptz,
  -- Tombstone: set first on deletion; helper functions then deny all access.
  deleted_at timestamptz
);

create trigger families_touch before update on public.families
  for each row execute function app.touch_updated_at();

create table public.family_memberships (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  user_id uuid not null references auth.users (id),
  role text not null check (role in ('owner', 'guardian')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by uuid references auth.users (id),
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index family_memberships_one_active_per_user_family
  on public.family_memberships (family_id, user_id) where status = 'active';
create unique index family_memberships_one_active_owner
  on public.family_memberships (family_id) where status = 'active' and role = 'owner';
create index family_memberships_user on public.family_memberships (user_id) where status = 'active';

-- Spec P1: up to two adult guardians per family (owner + one invited guardian).
create or replace function app.enforce_adult_limit() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  active_count integer;
begin
  if new.status <> 'active' then
    return new;
  end if;
  -- Serialize concurrent acceptances for the same family.
  perform 1 from public.families where id = new.family_id for update;
  select count(*) into active_count
    from public.family_memberships
   where family_id = new.family_id and status = 'active' and id <> new.id;
  if active_count >= 2 then
    raise exception 'family % already has the maximum of 2 active adults', new.family_id
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger family_memberships_adult_limit
  before insert or update of status on public.family_memberships
  for each row execute function app.enforce_adult_limit();

create or replace function app.is_family_member(p_family uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.family_memberships m
      join public.families f on f.id = m.family_id
     where m.family_id = p_family
       and m.user_id = app.current_user_id()
       and m.status = 'active'
       and f.deleted_at is null
  )
$$;

create or replace function app.is_family_owner(p_family uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.family_memberships m
      join public.families f on f.id = m.family_id
     where m.family_id = p_family
       and m.user_id = app.current_user_id()
       and m.status = 'active'
       and m.role = 'owner'
       and f.deleted_at is null
  )
$$;

-- Used by service-role handlers (which bypass RLS) before writing family data: no resurrection.
create or replace function app.family_is_active(p_family uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.families where id = p_family and deleted_at is null)
$$;

create table public.guardian_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  email citext not null,
  invited_by uuid not null references auth.users (id),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users (id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index guardian_invitations_one_pending
  on public.guardian_invitations (family_id, email) where status = 'pending';

create table private.guardian_invitation_tokens (
  invitation_id uuid primary key references public.guardian_invitations (id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Consent (spec P3/P4). Written only by the API after a provider result; parents read.
-- ---------------------------------------------------------------------------------------------

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  adult_user_id uuid not null references auth.users (id),
  provider text not null,
  provider_reference text,
  method text not null,
  purpose text not null,
  policy_version text not null,
  scope jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending', 'verified', 'failed', 'withdrawn')),
  -- True for development/test consent adapters. Production readiness rejects these rows.
  is_test_provider boolean not null,
  verified_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'verified' or verified_at is not null),
  check (status <> 'withdrawn' or withdrawn_at is not null)
);

create index consent_records_family on public.consent_records (family_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Adult step-up (PIN / biometric) — spec P3
-- ---------------------------------------------------------------------------------------------

create table private.parent_pins (
  user_id uuid primary key references auth.users (id),
  -- Peppered PBKDF2 hash produced by the API; never a raw PIN.
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table private.adult_unlocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  -- Bound to the Supabase auth session so a different device/session cannot reuse it.
  auth_session_id text not null,
  method text not null check (method in ('pin', 'biometric', 'password')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index adult_unlocks_lookup on private.adult_unlocks (user_id, auth_session_id, expires_at);

create or replace function app.has_recent_adult_unlock() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
      from private.adult_unlocks u
     where u.user_id = app.current_user_id()
       and u.auth_session_id = app.jwt_claims() ->> 'session_id'
       and u.revoked_at is null
       and u.expires_at > now()
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Children, devices, pairing and sessions — spec P3
-- ---------------------------------------------------------------------------------------------

create table public.child_profiles (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  nickname text not null check (char_length(nickname) between 1 and 40),
  -- 0 = kindergarten … 8 = grade 8 (launch scope K-8; widen later without rewrite).
  grade_level smallint not null check (grade_level between 0 and 12),
  age_band text not null check (age_band in ('5-7', '8-10', '11-13', '14-18')),
  -- draft: created, no paid slot, no premium access; active: holds a paid slot; archived: history only.
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  accessibility jsonb not null default '{}'::jsonb,
  curriculum_notes text check (char_length(curriculum_notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, family_id)
);

create index child_profiles_family on public.child_profiles (family_id);
create trigger child_profiles_touch before update on public.child_profiles
  for each row execute function app.touch_updated_at();

create table private.child_pins (
  child_id uuid primary key references public.child_profiles (id),
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table public.child_devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  label text not null check (char_length(label) between 1 and 60),
  platform text not null check (platform in ('ios', 'android', 'web')),
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create table private.child_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  code_hash bytea not null unique,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  failed_attempts integer not null default 0,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check (expires_at > created_at)
);

create table public.child_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  device_id uuid not null references public.child_devices (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create index child_sessions_child on public.child_sessions (child_id) where revoked_at is null;

create table private.child_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.child_sessions (id),
  token_hash bytea not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Rotation: a used token that is presented again signals theft; the API revokes the session.
  used_at timestamptz,
  replaced_by uuid references private.child_refresh_tokens (id)
);

create or replace function app.current_child_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select s.child_id
    from public.child_sessions s
    join public.child_profiles c on c.id = s.child_id
    join public.families f on f.id = s.family_id
    join public.child_devices d on d.id = s.device_id
   where app.jwt_claims() ->> 'role' = 'pl_child'
     and s.id = nullif(app.jwt_claims() ->> 'child_session_id', '')::uuid
     and s.child_id = nullif(app.jwt_claims() ->> 'child_id', '')::uuid
     and s.family_id = nullif(app.jwt_claims() ->> 'family_id', '')::uuid
     and s.revoked_at is null
     and s.expires_at > now()
     and d.revoked_at is null
     and c.status = 'active'
     and f.deleted_at is null
$$;

create or replace function app.current_child_family_id() returns uuid
language sql stable security definer
set search_path = ''
as $$
  select c.family_id from public.child_profiles c where c.id = app.current_child_id()
$$;

-- ---------------------------------------------------------------------------------------------
-- Owner administration and audit
-- ---------------------------------------------------------------------------------------------

create table public.admin_users (
  user_id uuid primary key references auth.users (id),
  role text not null check (role in ('owner_admin', 'support')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Owner admin requires MFA (aal2) on the current session, not merely a table row.
create or replace function app.is_owner_admin() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.jwt_claims() ->> 'aal' = 'aal2'
     and exists (
       select 1 from public.admin_users a
        where a.user_id = app.current_user_id()
          and a.role = 'owner_admin'
          and a.revoked_at is null
     )
$$;

create table public.audit_events (
  id bigint generated always as identity primary key,
  family_id uuid references public.families (id),
  actor_user_id uuid references auth.users (id),
  actor_kind text not null check (actor_kind in ('parent', 'child', 'admin', 'system', 'provider')),
  action text not null check (char_length(action) between 1 and 100),
  target_type text,
  target_id text,
  -- Pseudonymous identifiers and statuses only; never homework, answers or child content.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_family on public.audit_events (family_id, created_at desc);
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- RPC: create a family (verified adults only)
-- ---------------------------------------------------------------------------------------------

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
-- Row level security and grants
-- ---------------------------------------------------------------------------------------------

alter table public.families enable row level security;
alter table public.family_memberships enable row level security;
alter table public.guardian_invitations enable row level security;
alter table public.consent_records enable row level security;
alter table public.child_profiles enable row level security;
alter table public.child_devices enable row level security;
alter table public.child_sessions enable row level security;
alter table public.admin_users enable row level security;
alter table public.audit_events enable row level security;

-- Anonymous callers never read or write family data.
revoke all on public.families, public.family_memberships, public.guardian_invitations,
  public.consent_records, public.child_profiles, public.child_devices, public.child_sessions,
  public.admin_users, public.audit_events from anon;

-- Adults write through RPCs / the API only, except the explicitly granted columns below.
revoke insert, update, delete on public.families, public.family_memberships,
  public.guardian_invitations, public.consent_records, public.child_profiles,
  public.child_devices, public.child_sessions, public.admin_users, public.audit_events
  from authenticated;

grant update (display_name, timezone) on public.families to authenticated;
grant insert (family_id, nickname, grade_level, age_band, accessibility, curriculum_notes)
  on public.child_profiles to authenticated;
grant update (nickname, grade_level, age_band, accessibility, curriculum_notes)
  on public.child_profiles to authenticated;

create policy families_member_read on public.families
  for select to authenticated using (app.is_family_member(id));
create policy families_member_update on public.families
  for update to authenticated
  using (app.is_family_member(id) and app.has_recent_adult_unlock())
  with check (app.is_family_member(id));

create policy memberships_member_read on public.family_memberships
  for select to authenticated using (app.is_family_member(family_id));

create policy invitations_member_read on public.guardian_invitations
  for select to authenticated using (app.is_family_member(family_id));

create policy consent_member_read on public.consent_records
  for select to authenticated using (app.is_family_member(family_id));

create policy child_profiles_member_read on public.child_profiles
  for select to authenticated using (app.is_family_member(family_id));
-- Adding a child requires recent step-up and always creates an uncharged draft (spec P11).
create policy child_profiles_member_insert on public.child_profiles
  for insert to authenticated
  with check (app.is_family_member(family_id) and app.has_recent_adult_unlock() and status = 'draft');
create policy child_profiles_member_update on public.child_profiles
  for update to authenticated
  using (app.is_family_member(family_id) and app.has_recent_adult_unlock())
  with check (app.is_family_member(family_id));

create policy child_devices_member_read on public.child_devices
  for select to authenticated using (app.is_family_member(family_id));
create policy child_sessions_member_read on public.child_sessions
  for select to authenticated using (app.is_family_member(family_id));

create policy admin_users_self_read on public.admin_users
  for select to authenticated using (user_id = app.current_user_id());

create policy audit_member_read on public.audit_events
  for select to authenticated
  using ((family_id is not null and app.is_family_member(family_id)) or app.is_owner_admin());

-- Paired child sessions: explicit column allowlist, own rows only.
grant select (id, timezone) on public.families to pl_child;
grant select (id, family_id, nickname, grade_level, age_band, status, accessibility)
  on public.child_profiles to pl_child;

create policy families_child_read on public.families
  for select to pl_child using (id = app.current_child_family_id());
create policy child_profiles_child_read on public.child_profiles
  for select to pl_child using (id = app.current_child_id());

-- Postgres grants EXECUTE to PUBLIC by default; helper functions are for signed-in principals only.
revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to authenticated, service_role, pl_child;
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app grant execute on functions to authenticated, service_role, pl_child;

-- Service role (jobs/webhooks) manages private tables; nobody else has privileges there.
grant all on all tables in schema private to service_role;
alter default privileges in schema private grant all on tables to service_role;

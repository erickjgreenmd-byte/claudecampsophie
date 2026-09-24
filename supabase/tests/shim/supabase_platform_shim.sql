-- TEST-ONLY emulation of the Supabase platform objects that PencilLift migrations rely on.
-- This file is NOT a migration and is never applied to a hosted Supabase project.
-- It reproduces the security-relevant defaults so authorization tests fail the same way
-- production would: anon/authenticated receive table privileges by default in `public`,
-- so a table without RLS is exposed.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;

-- Roles are cluster-wide; tolerate concurrent creation by parallel test databases.
do $$ begin create role anon nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin create role authenticated nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls;
exception when duplicate_object or unique_violation then null; end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Supabase Auth sessions (column names and types as in GoTrue's auth.sessions). GoTrue inserts a
-- row at sign-in and deletes it on sign-out; access tokens carry its id as the `session_id` claim.
do $$ begin create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
exception when duplicate_object then null; end $$;

create table if not exists auth.sessions (
  id uuid not null primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz,
  refreshed_at timestamp without time zone,
  user_agent text,
  ip inet,
  tag text
);
create index if not exists sessions_user_id_idx on auth.sessions (user_id);
create index if not exists sessions_not_after_idx on auth.sessions (not_after desc);

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select auth.jwt() ->> 'role'
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  metadata jsonb,
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- Supabase default privileges in the exposed `public` schema.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

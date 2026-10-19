-- PencilLift database schema — STRUCTURE ONLY, no rows, no credentials.
--
-- DERIVED. Source of truth is supabase/migrations/ (44 files). This is what they produce when
-- applied in order to an empty database, dumped from schemas public, private and app only.
-- Regenerate with scripts/dump-schema.sh after any migration, in the same commit.
--
-- Generated: 2026-10-19T18:11:36Z from commit 70d352c
-- Migrations applied: 44
--
-- The auth schema is NOT here. It belongs to Supabase Auth; what the application expects of
-- it is documented in docs/Database_Schema.md, and supabase/tests/shim/ emulates it for tests.

--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: adult_auth_email(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.adult_auth_email(p_user uuid) RETURNS TABLE(email text, email_verified boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select u.email::text, u.email_confirmed_at is not null
    from auth.users u
   where u.id = p_user and u.deleted_at is null
$$;


--
-- Name: all_match(text[], text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.all_match(p_values text[], p_pattern text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(cardinality(p_values) > 0 and bool_and(v ~ p_pattern), false)
    from unnest(p_values) as v
$$;


--
-- Name: apply_points_to_balance(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.apply_points_to_balance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  insert into public.point_balances (child_id, family_id, balance)
    values (new.child_id, new.family_id, 0)
    on conflict (child_id) do nothing;
  update public.point_balances
     set balance = balance + new.points, updated_at = now()
   where child_id = new.child_id;
  return new;
exception
  when check_violation then
    raise exception 'insufficient points for child %', new.child_id using errcode = 'P0001';
end
$$;


--
-- Name: monetization_reference_ok(text, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.monetization_reference_ok(p_ref text, p_tag text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select case
    when p_ref is null then false
    when lower(btrim(p_ref)) like 'fixture:%' then char_length(btrim(p_ref)) >= 11
    else char_length(btrim(p_ref)) between 6 and 300
      and btrim(p_ref) !~ '^[\[{]'
      and btrim(p_ref) !~* '^(amzn1\.|eyJ[A-Za-z0-9_-]{8,}\.|bearer\s)'
      and btrim(p_ref) !~ '^[A-Za-z0-9+/=]{32,}$'
      and btrim(p_ref) !~* '^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*-2[0-9]$'
      and not (
        array_remove(regexp_split_to_array(
          case when p_tag is null or btrim(p_tag) = '' then lower(btrim(p_ref))
               else replace(lower(btrim(p_ref)), lower(btrim(p_tag)), ' ') end,
          '[^a-z0-9]+'), '')
        <@ array[
      'true', 'false', 'yes', 'no', 'on', 'off', 'ok', 'okay', 'enabled', 'disabled', 'approved',
      'granted', 'eligible', 'pending', 'unknown', 'none', 'null', 'undefined', 'na', 'tbd', 'todo',
      'test', 'testing', 'fixture', 'mock', 'placeholder', 'evidence', 'y', 'n', 'a', '0', '1', 'nil',
      'enable', 'disable', 'approve', 'approval', 'grant', 'eligibility', 'verified', 'confirmed',
      'accepted', 'allowed', 'active', 'live', 'done', 'complete', 'completed', 'pass', 'passed',
      'valid', 'checked', 'reviewed', 'review', 'status', 'flag', 'set', 'value', 'is', 'was', 'has',
      'been', 'by', 'the', 'and', 'for', 'of', 'to', 'in', 'it', 'we', 'are', 'our', 'all', 'see',
      'amazon', 'associate', 'associates', 'affiliate', 'program', 'programme', 'account', 'sponsor',
      'direct', 'network', 'ad', 'ads', 'provider', 'ios', 'android', 'web', 'app', 'apps', 'mobile',
      'site', 'website', 'store', 'tag', 'tracking', 'id', 'publisher', 'key', 'api', 'client',
      'secret', 'token', 'policy'
        ]::text[])
  end
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: monetization_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monetization_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    platform text NOT NULL,
    property_identifier text NOT NULL,
    locale text NOT NULL,
    intended_audience text NOT NULL,
    vendor_sdk_version text,
    policy_reviewed_at timestamp with time zone NOT NULL,
    evidence_ref text NOT NULL,
    approval_scope text NOT NULL,
    publisher_tag text,
    linking_tool_ref text,
    status text DEFAULT 'pending'::text NOT NULL,
    status_reason text,
    expires_at timestamp with time zone NOT NULL,
    recorded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monetization_approvals_approval_scope_check CHECK (((char_length(btrim(approval_scope)) >= 3) AND (char_length(btrim(approval_scope)) <= 500))),
    CONSTRAINT monetization_approvals_check CHECK ((expires_at > policy_reviewed_at)),
    CONSTRAINT monetization_approvals_check1 CHECK (((provider = 'amazon_associates'::text) OR (publisher_tag IS NULL))),
    CONSTRAINT monetization_approvals_check2 CHECK (((provider = 'amazon_associates'::text) OR (linking_tool_ref IS NULL))),
    CONSTRAINT monetization_approvals_evidence_ref_check CHECK (app.monetization_reference_ok(evidence_ref, publisher_tag)),
    CONSTRAINT monetization_approvals_intended_audience_check CHECK (((char_length(btrim(intended_audience)) >= 3) AND (char_length(btrim(intended_audience)) <= 200))),
    CONSTRAINT monetization_approvals_linking_tool_ref_check CHECK (((linking_tool_ref IS NULL) OR app.monetization_reference_ok(linking_tool_ref, publisher_tag))),
    CONSTRAINT monetization_approvals_locale_check CHECK ((locale ~ '^[a-z]{2}-[A-Z]{2}$'::text)),
    CONSTRAINT monetization_approvals_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))),
    CONSTRAINT monetization_approvals_property_identifier_check CHECK (((char_length(property_identifier) >= 3) AND (char_length(property_identifier) <= 200))),
    CONSTRAINT monetization_approvals_provider_check CHECK ((provider = ANY (ARRAY['sponsor_direct'::text, 'amazon_associates'::text, 'ad_network'::text]))),
    CONSTRAINT monetization_approvals_publisher_tag_check CHECK ((publisher_tag ~* '^[a-z0-9][a-z0-9-]{1,60}-[0-9]{2}$'::text)),
    CONSTRAINT monetization_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'revoked'::text, 'expired'::text]))),
    CONSTRAINT monetization_approvals_status_reason_check CHECK ((char_length(status_reason) <= 300)),
    CONSTRAINT monetization_approvals_vendor_sdk_version_check CHECK (((char_length(vendor_sdk_version) >= 1) AND (char_length(vendor_sdk_version) <= 60)))
);


--
-- Name: approval_is_fake(public.monetization_approvals); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.approval_is_fake(p_row public.monetization_approvals) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.status in ('pending', 'approved')
    and (app.is_fixture_label(p_row.evidence_ref) or app.is_fixture_label(p_row.linking_tool_ref))
$$;


--
-- Name: assert_parent_child_write(uuid, uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.assert_parent_child_write(p_family uuid, p_child uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  child_status text;
begin
  if not app.is_family_member(p_family) then
    raise exception 'family not found' using errcode = '42501';
  end if;
  select c.status into child_status
    from public.child_profiles c where c.id = p_child and c.family_id = p_family;
  if child_status is null then
    raise exception 'child not found' using errcode = '42501';
  end if;
  if child_status = 'archived' then
    raise exception 'the child profile is archived: nothing new can be added or changed for it'
      using errcode = '42501', constraint = 'child_archived_no_write';
  end if;
  if exists (
    select 1 from public.deletion_requests d
     where d.family_id = p_family
       and d.status in ('requested', 'processing')
       and (d.scope = 'family' or d.target_child_id = p_child)
  ) then
    raise exception 'a data deletion covering this child is under way: nothing new can be added'
      using errcode = '42501', constraint = 'child_deletion_no_write';
  end if;
end
$$;


--
-- Name: auth_session_active(uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.auth_session_active(p_user uuid, p_session text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: auth_session_ended(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.auth_session_ended() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: auth_user_closed(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.auth_user_closed(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select p_user is null
      or not exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null)
$$;


--
-- Name: bump_schedule_version_on_change(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.bump_schedule_version_on_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.review_weekday is distinct from old.review_weekday
     or new.review_local_time is distinct from old.review_local_time then
    new.schedule_version := old.schedule_version + 1;
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: bump_schedule_version_on_test_date(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.bump_schedule_version_on_test_date() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target uuid := coalesce(new.child_id, old.child_id);
begin
  if app.purge_in_progress() then
    return null;
  end if;
  update public.learning_schedules
     set schedule_version = schedule_version + 1, updated_at = now()
   where child_id = target;
  return null;
end
$$;


--
-- Name: child_pairing_codes_before_insert(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.child_pairing_codes_before_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: child_profiles_end_pairing_codes(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.child_profiles_end_pairing_codes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update private.child_pairing_codes
     set consumed_at = now()
   where child_id = new.id and consumed_at is null;
  return null;
end
$$;


--
-- Name: child_profiles_no_activation_under_deletion(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.child_profiles_no_activation_under_deletion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.status = 'active' and old.status is distinct from 'active' and exists (
    select 1 from public.deletion_requests d
     where d.family_id = new.family_id
       and d.status in ('requested', 'processing')
       and (d.scope = 'family' or d.target_child_id = new.id)
  ) then
    raise exception 'a data deletion covering this child is under way: it cannot be activated'
      using errcode = '42501', constraint = 'child_profiles_no_activation_under_deletion';
  end if;
  return new;
end
$$;


--
-- Name: child_request_instant(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.child_request_instant() RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(nullif(current_setting('pencillift.request_now', true), '')::timestamptz, now())
$$;


--
-- Name: close_auth_user_locally(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.close_auth_user_locally(p_user uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: current_child_family_id(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.current_child_family_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select c.family_id from public.child_profiles c where c.id = app.current_child_id()
$$;


--
-- Name: current_child_id(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.current_child_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: current_user_id(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select case
    when app.jwt_claims() ->> 'role' = 'authenticated'
      then nullif(app.jwt_claims() ->> 'sub', '')::uuid
  end
$$;


--
-- Name: data_api_learning_write_guard(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_api_learning_write_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  rows_this_hour integer;
begin
  -- Only the Data API / parent role is held here. The API's jobs and its service-role routes write
  -- history for archived children and in bulk on purpose (scan processing, purges, billing sync),
  -- and the routes that write as the parent already applied these rules before the statement ran.
  -- SECURITY INVOKER, so current_user is the role the statement really runs as.
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_table_name = 'learning_schedules' then
    perform app.assert_parent_child_write(new.family_id, new.child_id);
    return new;
  end if;

  perform app.assert_parent_child_write(new.family_id, new.child_id);

  if tg_table_name = 'child_subjects' then
    if app.text_has_control_character(new.display_name) then
      raise exception 'subject name holds control characters'
        using errcode = '22023', constraint = 'child_subjects_no_control_characters';
    end if;
    -- The bound counts only the rows the API's own limiter counts, and only on INSERT:
    --   * PATCH /children/:childId/subjects (routes/learning.ts, toggle or rename) has no limiter
    --     and stores no new row, so an UPDATE is never counted;
    --   * GET /children/:childId/subjects creates a child's six default subjects lazily
    --     (ensureLearningDefaults, apps/api/src/jobs/learning-jobs.ts) as the parent role, one row
    --     per (child_id, subject_key), and that read path is not limited either. So the FIRST row of
    --     each (child_id, subject_key) pair in the hour is free and only the extra rows of a pair
    --     count. That keeps the rule independent of the default display names (child_subjects has a
    --     unique index on (child_id, lower(display_name)) only, so 'math' with fresh names is a
    --     flood vector just like 'custom'), and it cannot refuse a family whose 12 children all had
    --     their lists opened in the same hour.
    -- RATE_RULES.subjectCreatePerFamily = 20 requests/hour, so at most 40 creations can fall inside
    -- one sliding hour across a fixed-window boundary; those leave at most 39 extra rows, under the
    -- bound. The database's job is only to stop a single statement writing hundreds of rows.
    if tg_op = 'INSERT' then
      select coalesce(sum(greatest(g.n - 1, 0)), 0) into rows_this_hour
        from (select s.child_id, s.subject_key, count(*)::integer as n
                from public.child_subjects s
               where s.family_id = new.family_id and s.created_at > now() - interval '1 hour'
               group by s.child_id, s.subject_key) g;
      if rows_this_hour >= 40 then
        raise exception 'too many subjects added for this family in the last hour'
          using errcode = '53400', constraint = 'child_subjects_family_hourly_bound';
      end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'test_dates' then
    if app.text_has_control_character(new.scope_notes) then
      raise exception 'test scope notes hold control characters'
        using errcode = '22023', constraint = 'test_dates_no_control_characters';
    end if;
    -- RATE_RULES.testDateCreatePerFamily = 30/hour.
    select count(*) into rows_this_hour
      from public.test_dates t
     where t.family_id = new.family_id and t.created_at > now() - interval '1 hour';
    if rows_this_hour >= 60 then
      raise exception 'too many test dates added for this family in the last hour'
        using errcode = '53400', constraint = 'test_dates_family_hourly_bound';
    end if;
    return new;
  end if;

  if tg_table_name = 'study_materials' then
    if app.text_has_control_character(new.content_text) then
      raise exception 'study material holds control characters'
        using errcode = '22023', constraint = 'study_materials_no_control_characters';
    end if;
    -- RATE_RULES.studyMaterialCreatePerFamily = 30/hour; rows hold up to 20 KB of text.
    select count(*) into rows_this_hour
      from public.study_materials m
     where m.family_id = new.family_id and m.created_at > now() - interval '1 hour';
    if rows_this_hour >= 60 then
      raise exception 'too many study materials added for this family in the last hour'
        using errcode = '53400', constraint = 'study_materials_family_hourly_bound';
    end if;
    return new;
  end if;

  return new;
end
$$;


--
-- Name: data_api_reward_write_guard(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_api_reward_write_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  rows_this_hour integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Only a NEW reward needs a writable child, exactly as routes/rewards.ts does: POST /rewards
  -- refuses an archived child and one under deletion, while PATCH /rewards/:id (rename, re-price,
  -- deactivate) does not, so a parent can still switch off a reward of a child they archived.
  if tg_op = 'INSERT' and new.child_id is not null then
    perform app.assert_parent_child_write(new.family_id, new.child_id);
  end if;
  if app.text_has_control_character(new.title)
     or app.text_has_control_character(new.instructions) then
    raise exception 'reward text holds control characters'
      using errcode = '22023', constraint = 'rewards_no_control_characters';
  end if;
  if tg_op = 'INSERT' then
    -- RATE_RULES.rewardCreatePerFamily = 40/hour.
    select count(*) into rows_this_hour
      from public.rewards r
     where r.family_id = new.family_id and r.created_at > now() - interval '1 hour';
    if rows_this_hour >= 80 then
      raise exception 'too many rewards added for this family in the last hour'
        using errcode = '53400', constraint = 'rewards_family_hourly_bound';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: data_api_support_write_guard(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_api_support_write_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  fam uuid;
  rows_this_hour integer;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_table_name = 'support_cases' then
    if app.text_has_control_character(new.subject) or app.text_has_control_character(new.body) then
      raise exception 'support case text holds control characters'
        using errcode = '22023', constraint = 'support_cases_no_control_characters';
    end if;
    if new.opened_by_kind = 'parent' then
      select count(*) into rows_this_hour
        from public.support_cases c
       where c.family_id = new.family_id and c.opened_by_kind = 'parent'
         and c.created_at > now() - interval '1 hour';
      if rows_this_hour >= 20 then
        raise exception 'too many support cases opened for this family in the last hour'
          using errcode = '53400', constraint = 'support_cases_family_hourly_bound';
      end if;
    end if;
    return new;
  end if;

  -- support_case_messages
  if app.text_has_control_character(new.body) then
    raise exception 'support message holds control characters'
      using errcode = '22023', constraint = 'support_case_messages_no_control_characters';
  end if;
  if new.author_kind = 'parent' then
    select c.family_id into fam from public.support_cases c where c.id = new.case_id;
    select count(*) into rows_this_hour
      from public.support_case_messages m
      join public.support_cases c on c.id = m.case_id
     where c.family_id = fam and m.author_kind = 'parent'
       and m.created_at > now() - interval '1 hour';
    if rows_this_hour >= 60 then
      raise exception 'too many support replies from this family in the last hour'
        using errcode = '53400', constraint = 'support_case_messages_family_hourly_bound';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: data_api_test_date_delete_guard(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.data_api_test_date_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if current_user <> 'authenticated' then
    return old;
  end if;
  perform app.assert_parent_child_write(old.family_id, old.child_id);
  return old;
end
$$;


--
-- Name: database_environment(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.database_environment() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select environment from private.deployment where singleton
$$;


--
-- Name: enforce_adult_limit(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.enforce_adult_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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


--
-- Name: enforce_slot_capacity(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.enforce_slot_capacity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  capacity smallint;
  open_count integer;
begin
  if new.released_at is not null then
    return new;
  end if;
  -- Serialize concurrent assignments for one family (two guardians, two devices).
  perform 1 from public.families where id = new.family_id for update;
  select coalesce((select paid_slots from public.family_capacity where family_id = new.family_id), 0)
    into capacity;
  select count(*) into open_count
    from public.child_slot_assignments
   where family_id = new.family_id and released_at is null and id <> new.id;
  if open_count + 1 > capacity then
    raise exception 'paid capacity % exhausted for family %', capacity, new.family_id
      using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: fake_catalog_rows(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.fake_catalog_rows() RETURNS TABLE(catalog text, fake_rows integer)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select 'resource_catalog', count(*)::integer
    from public.resource_catalog r where app.resource_is_fake(r)
  union all
  select 'monetization_approvals', count(*)::integer
    from public.monetization_approvals a where app.approval_is_fake(a)
  union all
  select 'store_product_mappings', count(*)::integer
    from public.store_product_mappings m where app.store_product_is_fake(m)
  union all
  select 'store_feature_mappings', count(*)::integer
    from public.store_feature_mappings m where app.store_feature_is_fake(m)
  union all
  select 'provider_offer_mappings', count(*)::integer
    from public.provider_offer_mappings m where app.provider_offer_is_fake(m)
  union all
  select 'sponsors', count(*)::integer
    from public.sponsors s where app.sponsor_is_fake(s)
  union all
  select 'sponsor_campaigns', count(*)::integer
    from public.sponsor_campaigns c where app.sponsor_campaign_is_fake(c)
$$;


--
-- Name: families_require_iana_timezone(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.families_require_iana_timezone() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.timezone is null
     or new.timezone in ('localtime', 'Factory', 'posixrules')
     or new.timezone like 'posix/%' or new.timezone like 'right/%'
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


--
-- Name: family_is_active(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.family_is_active(p_family uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (select 1 from public.families where id = p_family and deleted_at is null)
$$;


--
-- Name: family_may_be_charged(uuid, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.family_may_be_charged(p_family uuid, p_now timestamp with time zone) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.family_entitlements e
     where e.family_id = p_family
       and e.status not in ('expired', 'revoked', 'refunded')
       and (e.period_end is null or e.period_end > p_now
            or e.status in ('grace_period', 'billing_retry')
            or e.auto_renew))
$$;


--
-- Name: guard_aggregate_ad_event(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_aggregate_ad_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'aggregate counters are never deleted' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'count') <> (to_jsonb(old) - 'count') or new.count < old.count then
    raise exception 'aggregate counters only increase' using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_ai_usage_event(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_ai_usage_event() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'UPDATE' and app.purge_in_progress()
     and new.child_id is null and old.child_id is not null
     and (to_jsonb(new) - 'child_id') = (to_jsonb(old) - 'child_id') then
    return new;
  end if;
  raise exception 'table %.% is append-only; record an adjustment instead', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;


--
-- Name: guard_assignment_transition(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_assignment_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.status is distinct from old.status and not (
       new.status = 'deleted'
    or (old.status = 'draft' and new.status in ('uploading', 'cancelled'))
    or (old.status = 'uploading' and new.status in ('queued', 'cancelled', 'failed_retryable'))
    or (old.status = 'queued' and new.status in ('extracting', 'cancelled'))
    or (old.status = 'extracting' and new.status in ('checking', 'needs_rescan', 'needs_parent_review', 'failed_retryable', 'failed_final'))
    or (old.status = 'checking' and new.status in ('verifying', 'needs_parent_review', 'failed_retryable', 'failed_final'))
    or (old.status = 'verifying' and new.status in ('ready', 'needs_parent_review', 'failed_retryable', 'failed_final'))
    or (old.status = 'failed_retryable' and new.status in ('queued', 'failed_final', 'cancelled'))
    or (old.status = 'needs_rescan' and new.status in ('uploading', 'cancelled'))
    or (old.status = 'needs_parent_review' and new.status in ('checking', 'ready'))
    or (old.status = 'ready' and new.status = 'checking')
  ) then
    raise exception 'invalid assignment transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status = 'deleted' and new.status = 'deleted' and new is distinct from old then
    raise exception 'deleted assignments are immutable' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: guard_deployment_mark(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_deployment_mark() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.environment = 'production' then
    -- Waits for in-flight catalog writers and holds new ones until this commits, so no fake row can
    -- land between the check and the mark.
    lock table public.resource_catalog, public.monetization_approvals, public.store_product_mappings,
      public.store_feature_mappings, public.provider_offer_mappings, public.sponsors,
      public.sponsor_creatives, public.sponsor_campaigns in share mode;
    if exists (select 1 from app.fake_catalog_rows() f where f.fake_rows > 0) then
      raise exception 'fixture or fake catalog rows are live; retire, revoke or deactivate them before marking this database production'
        using errcode = 'P0001';
    end if;
  end if;
  new.marked_at := now();
  return new;
end
$$;


--
-- Name: guard_job(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_job() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.family_id is not null and new.status in ('queued', 'running')
     and new.kind not in ('deletion_purge') and not app.family_is_active(new.family_id) then
    raise exception 'family % is deleted; job % refused', new.family_id, new.kind using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.status in ('succeeded', 'failed_final', 'cancelled', 'dead_letter')
     and new.status is distinct from old.status then
    raise exception 'job % is terminal (%)', old.id, old.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: guard_ledger_row(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_ledger_row() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger rows in %.% are never deleted', tg_table_schema, tg_table_name using errcode = 'P0001';
  end if;
  if old.payout_batch_id is not null and new.payout_batch_id is distinct from old.payout_batch_id then
    raise exception 'ledger row already belongs to a payout batch' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'payout_batch_id') <> (to_jsonb(old) - 'payout_batch_id') then
    raise exception 'ledger facts are immutable; record an adjustment' using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_monetization_approval(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_monetization_approval() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if (to_jsonb(new) - array['status', 'status_reason', 'updated_at'])
     <> (to_jsonb(old) - array['status', 'status_reason', 'updated_at']) then
    raise exception 'approval evidence is immutable; record a new approval' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'rejected', 'revoked'))
    or (old.status = 'approved' and new.status in ('revoked', 'expired'))
  ) then
    raise exception 'invalid approval transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: guard_redemption_transition(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_redemption_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.state is distinct from old.state and not (
       (old.state = 'reserved' and new.state in ('provider_pending', 'expired'))
    or (old.state = 'provider_pending' and new.state in ('confirmed', 'rejected'))
    or (old.state = 'confirmed' and new.state = 'reconciled')
  ) then
    raise exception 'invalid redemption transition % -> %', old.state, new.state using errcode = 'P0001';
  end if;
  if new.family_id <> old.family_id or new.campaign_id <> old.campaign_id or new.code_id <> old.code_id
     or new.target_period_key <> old.target_period_key or new.idempotency_key <> old.idempotency_key
     or new.redeemed_by <> old.redeemed_by then
    raise exception 'redemption identity is immutable' using errcode = 'P0001';
  end if;
  if old.state in ('confirmed', 'reconciled') and (
       new.discount_cents <> old.discount_cents or new.charged_cents <> old.charged_cents) then
    raise exception 'confirmed redemption amounts are immutable' using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_revenue_adjustment(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_revenue_adjustment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  base bigint;
  adjusted bigint;
begin
  select amount_cents into base from public.revenue_entries where id = new.entry_id for update;
  select coalesce(sum(amount_cents), 0) into adjusted from public.revenue_adjustments where entry_id = new.entry_id;
  if base + adjusted + new.amount_cents < 0 then
    raise exception 'adjustment would take the entry below zero' using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_revenue_entry_campaign(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_revenue_entry_campaign() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  campaign_placement text;
begin
  if new.campaign_id is not null then
    select placement into campaign_placement from public.sponsor_campaigns where id = new.campaign_id;
    if campaign_placement is not null and new.placement is distinct from campaign_placement then
      raise exception 'revenue row placement % does not match its campaign placement %',
        new.placement, campaign_placement using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: guard_reward_redemption(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_reward_redemption() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    if app.purge_in_progress() then
      return old;
    end if;
    raise exception 'reward redemptions are never deleted' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending' and new.state in ('approved', 'declined', 'cancelled'))
    or (old.state = 'approved' and new.state in ('fulfilled', 'cancelled'))
  ) then
    raise exception 'invalid reward redemption transition % -> %', old.state, new.state using errcode = 'P0001';
  end if;
  if new.point_cost <> old.point_cost or new.child_id <> old.child_id or new.reward_id <> old.reward_id then
    raise exception 'reward redemption facts are immutable' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: guard_safety_report_resolution(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_safety_report_resolution() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.resolution is distinct from old.resolution
     and (old.resolution is not null or old.status = 'resolved') then
    raise exception 'safety report % resolution is final', old.id using errcode = 'P0001';
  end if;
  if new.resolution is not null and new.family_visible and not old.family_visible then
    raise exception 'a held safety report cleared as a false match is never released'
      using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_sponsor_campaign(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_sponsor_campaign() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  creative_status text;
  sponsor_status text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'campaigns start as drafts' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.sponsor_id <> old.sponsor_id or new.created_by <> old.created_by then
    raise exception 'campaign sponsor is immutable' using errcode = 'P0001';
  end if;
  -- An ended campaign is frozen except for its invoice/payment bookkeeping.
  if old.status = 'ended' and (to_jsonb(new) - array['invoice_status', 'updated_at'])
       <> (to_jsonb(old) - array['invoice_status', 'updated_at']) then
    raise exception 'campaign has ended' using errcode = 'P0001';
  end if;
  -- A changed creative (or audience surface) needs human review again (spec P16.5).
  if (new.creative_id <> old.creative_id or new.placement <> old.placement or new.platforms <> old.platforms)
     and old.status in ('scheduled', 'active', 'paused') then
    if new.status is distinct from old.status and new.status <> 'in_review' then
      raise exception 'a changed campaign must return to review' using errcode = 'P0001';
    end if;
    new.status := 'in_review';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'in_review')
    or (old.status = 'in_review' and new.status in ('scheduled', 'rejected'))
    or (old.status = 'scheduled' and new.status in ('active', 'paused', 'ended', 'in_review'))
    or (old.status = 'active' and new.status in ('paused', 'ended', 'in_review'))
    or (old.status = 'paused' and new.status in ('active', 'ended', 'in_review'))
    or (old.status = 'rejected' and new.status = 'draft')
  ) then
    raise exception 'invalid campaign transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if new.status in ('scheduled', 'active') then
    select review_status into creative_status from public.sponsor_creatives where id = new.creative_id;
    if creative_status is distinct from 'approved' then
      raise exception 'only an approved creative version can be scheduled or active' using errcode = 'P0001';
    end if;
    select status into sponsor_status from public.sponsors where id = new.sponsor_id;
    if sponsor_status is distinct from 'active' then
      raise exception 'sponsor is suspended' using errcode = 'P0001';
    end if;
  end if;
  if new.status <> 'paused' then
    new.paused_reason := null;
  end if;
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: guard_sponsor_creative(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_sponsor_creative() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.review_status <> 'draft' then
      raise exception 'a new creative version starts as a draft' using errcode = 'P0001';
    end if;
    -- The label is always the sponsor's name at creation time, never a caller-supplied value.
    new.sponsor_name := (select s.business_name from public.sponsors s where s.id = new.sponsor_id);
    return new;
  end if;
  if old.review_status in ('approved', 'rejected') then
    raise exception 'creative version % is %; create a new version instead', old.version, old.review_status
      using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'review_note', 'self_reviewed'])
     <> (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'review_note', 'self_reviewed']) then
    raise exception 'creative content is immutable; create a new version' using errcode = 'P0001';
  end if;
  if new.review_status is distinct from old.review_status and not (
       (old.review_status = 'draft' and new.review_status = 'in_review')
    or (old.review_status = 'in_review' and new.review_status in ('approved', 'rejected', 'draft'))
  ) then
    raise exception 'invalid creative review transition % -> %', old.review_status, new.review_status
      using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: guard_usage_transition(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.guard_usage_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.child_id is null then
      raise exception 'usage reservation requires a child' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status <> 'reserved' and new.status is distinct from old.status then
    raise exception 'usage reservation % is % and cannot become %', old.id, old.status, new.status
      using errcode = 'P0001';
  end if;
  if new.units <> old.units or new.family_id <> old.family_id
     or new.period_key <> old.period_key or new.idempotency_key <> old.idempotency_key
     or (new.child_id is distinct from old.child_id
         and not (new.child_id is null and app.purge_in_progress())) then
    raise exception 'usage reservation facts are immutable' using errcode = 'P0001';
  end if;
  return new;
end
$$;


--
-- Name: has_recent_adult_unlock(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.has_recent_adult_unlock() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
      from private.adult_unlocks u
     where u.user_id = app.current_user_id()
       and u.auth_session_id = app.jwt_claims() ->> 'session_id'
       and u.revoked_at is null
       and u.expires_at > now()
  )
$$;


--
-- Name: inactivity_delete_family(uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.inactivity_delete_family(p_family uuid, p_now timestamp with time zone, p_idle_before timestamp with time zone, p_notice_before timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  fam public.families;
  req public.deletion_requests;
  last_active timestamptz;
begin
  select * into fam from public.families where id = p_family for update;
  if not found or fam.deleted_at is not null or fam.inactivity_notified_at is null then
    return null;
  end if;
  select greatest(
           fam.created_at,
           coalesce((select max(m.last_seen_at) from public.family_memberships m where m.family_id = p_family), fam.created_at),
           coalesce((select max(a.created_at) from public.assignments a where a.family_id = p_family), fam.created_at),
           coalesce((select max(t.created_at) from public.attempts t where t.family_id = p_family), fam.created_at))
    into last_active;
  if last_active >= p_idle_before
     or fam.inactivity_notified_at <= last_active
     or fam.inactivity_notified_at >= p_notice_before then
    return null;
  end if;
  -- A family still paying for a subscription is never deleted for inactivity (store billing keeps
  -- charging; deletion must not surprise-cancel or imply a cancellation; RV-lead-jobs-ai-13).
  if app.family_may_be_charged(p_family, p_now) then
    return null;
  end if;

  insert into public.deletion_requests (family_id, scope, requested_by)
    values (p_family, 'family', fam.created_by)
    returning * into req;
  update public.child_sessions set revoked_at = now(), revoke_reason = 'deletion'
   where family_id = p_family and revoked_at is null;
  update public.child_devices set revoked_at = now() where family_id = p_family and revoked_at is null;
  update public.jobs set status = 'cancelled', updated_at = now()
   where family_id = p_family and status in ('queued', 'failed_retryable');
  update public.assignments set status = 'deleted' where family_id = p_family and status <> 'deleted';
  update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
  -- The adults are released with the tombstone, not by the later purge (DB-R1-02).
  update public.family_memberships set status = 'revoked', revoked_at = now()
   where family_id = p_family and status = 'active';
  -- HUNT7-D-4: the same two export statements public.request_deletion runs, because this is the
  -- other writer of a family-scope deletion_requests row and L-037 asks for the effect on every
  -- surface that files the action. The instant is p_now — the clock the TICK stated — and not now():
  -- this function's caller is apps/api/src/jobs/dispatcher.ts, whose clock is the application's, and
  -- an instant comparison on an unstated clock is the BUG-090 shape.
  update public.data_exports
     set status = 'expired',
         expires_at = least(coalesce(expires_at, p_now), p_now)
   where family_id = p_family and status = 'ready';
  update public.data_exports set status = 'failed'
   where family_id = p_family and status = 'queued';
  insert into public.jobs (kind, idempotency_key, family_id, payload)
    values ('deletion_purge', 'deletion:' || req.id::text, p_family,
            jsonb_build_object('deletionRequestId', req.id, 'reason', 'inactivity'));
  insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
    values (p_family, 'system', 'deletion.inactivity', 'family', p_family::text);
  return req.id;
end
$$;


--
-- Name: is_family_member(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_family_member(p_family uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: is_family_owner(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_family_owner(p_family uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: is_fixture_label(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_fixture_label(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(lower(btrim(p_value)) ~ '^fixture[:._-]', false)
$$;


--
-- Name: is_owner_admin(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_owner_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select app.jwt_claims() ->> 'aal' = 'aal2'
     and exists (
       select 1 from public.admin_users a
        where a.user_id = app.current_user_id()
          and a.role = 'owner_admin'
          and a.revoked_at is null
     )
$$;


--
-- Name: is_reserved_test_domain(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_reserved_test_domain(p_domain text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select coalesce(lower(btrim(p_domain))
    ~ '^([a-z0-9-]+\.)*(example\.(com|net|org)|example|test|invalid|localhost)\.?$', false)
$_$;


--
-- Name: is_reserved_test_url(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_reserved_test_url(p_url text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select coalesce(lower(btrim(p_url)) ~ ('^[a-z][a-z0-9+.-]*://([^/?#@]*@)?([a-z0-9-]+\.)*'
    || '(example\.(com|net|org)|example|test|invalid|localhost)\.?(:[0-9]+)?([/?#]|$)'), false)
$_$;


--
-- Name: is_school_admin(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.is_school_admin(p_school uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.school_admins a
     where a.school_id = p_school and a.user_id = app.current_user_id() and a.revoked_at is null
  )
$$;


--
-- Name: jwt_claims(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.jwt_claims() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;


--
-- Name: late_upload_window(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.late_upload_window() RETURNS interval
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$ select interval '3 hours' $$;


--
-- Name: monetization_no_delete(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.monetization_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception 'rows in %.% are never deleted (audit trail)', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;


--
-- Name: no_delete(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.no_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception 'rows in %.% are never deleted', tg_table_schema, tg_table_name using errcode = 'P0001';
end
$$;


--
-- Name: prevent_mutation(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.prevent_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' and app.purge_in_progress() then
    return old;
  end if;
  raise exception 'table %.% is append-only; record an adjustment instead', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;


--
-- Name: program_calendar_zone(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.program_calendar_zone() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select nullif(current_setting('pencillift.program_zone', true), '')
$$;


--
-- Name: provider_offer_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_offer_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    channel text NOT NULL,
    paid_slots smallint NOT NULL,
    provider_offer_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_offer_mappings_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT provider_offer_mappings_check CHECK (((status <> 'ready'::text) OR (provider_offer_id IS NOT NULL))),
    CONSTRAINT provider_offer_mappings_check1 CHECK (((status <> ALL (ARRAY['failed'::text, 'unsupported'::text])) OR (reason IS NOT NULL))),
    CONSTRAINT provider_offer_mappings_paid_slots_check CHECK (((paid_slots >= 1) AND (paid_slots <= 12))),
    CONSTRAINT provider_offer_mappings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'unsupported'::text])))
);


--
-- Name: provider_offer_is_fake(public.provider_offer_mappings); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.provider_offer_is_fake(p_row public.provider_offer_mappings) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.status = 'ready' and app.is_fixture_label(p_row.provider_offer_id)
$$;


--
-- Name: prune_credential_rows(interval); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.prune_credential_rows(p_older_than interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  cutoff timestamptz;
  n_codes integer;
  n_holds integer;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'credential retention horizon must be at least one day' using errcode = '22023';
  end if;
  cutoff := now() - p_older_than;

  delete from private.child_pairing_codes c
   where least(c.expires_at, coalesce(c.consumed_at, c.expires_at)) < cutoff;
  get diagnostics n_codes = row_count;

  delete from private.ai_spend_holds h where h.expires_at < now() - interval '1 day';
  get diagnostics n_holds = row_count;

  return n_codes + n_holds;
end
$$;


--
-- Name: prune_session_rows(interval); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.prune_session_rows(p_older_than interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  cutoff timestamptz;
  n_tokens integer;
  n_sessions integer;
  n_unlocks integer;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'session retention horizon must be at least one day' using errcode = '22023';
  end if;
  cutoff := now() - p_older_than;

  delete from private.child_refresh_tokens t
   using public.child_sessions s
   where t.session_id = s.id
     and least(s.expires_at, coalesce(s.revoked_at, s.expires_at)) < cutoff;
  get diagnostics n_tokens = row_count;

  delete from public.child_sessions s
   where least(s.expires_at, coalesce(s.revoked_at, s.expires_at)) < cutoff;
  get diagnostics n_sessions = row_count;

  delete from private.adult_unlocks u
   where least(u.expires_at, coalesce(u.revoked_at, u.expires_at)) < cutoff;
  get diagnostics n_unlocks = row_count;

  return n_tokens + n_sessions + n_unlocks;
end
$$;


--
-- Name: prune_terminal_jobs(interval); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.prune_terminal_jobs(p_older_than interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  n integer;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'job retention horizon must be at least one day' using errcode = '22023';
  end if;
  delete from public.jobs
   where status in ('succeeded', 'cancelled', 'dead_letter')
     and kind not in ('deletion_purge', 'account_close')
     and updated_at < app.request_instant() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$$;


--
-- Name: pseudonymise_late_usage(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.pseudonymise_late_usage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.child_id is null then
    return new;
  end if;
  if new.family_id is not null then
    perform 1 from public.families where id = new.family_id for key share;
  end if;
  if not exists (select 1 from public.child_profiles where id = new.child_id) then
    new.child_id := null;
  end if;
  return new;
end
$$;


--
-- Name: purge_ended_auth_sessions(integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.purge_ended_auth_sessions(p_max integer DEFAULT 10000) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: purge_expired_rate_limit_buckets(timestamp with time zone, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.purge_expired_rate_limit_buckets(p_cutoff timestamp with time zone, p_max integer DEFAULT 10000) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: purge_family_data(uuid, uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.purge_family_data(p_family uuid, p_child uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  fam public.families;
  children uuid[];
  child_texts text[];
  assignment_ids text[];
  export_ids text[];
  paths text[];
  counts jsonb := '{}'::jsonb;
  n integer;
begin
  select * into fam from public.families where id = p_family for update;
  if not found then
    raise exception 'family not found' using errcode = 'P0002';
  end if;
  if p_child is null then
    if fam.deleted_at is null then
      raise exception 'family must be tombstoned before purge' using errcode = 'P0001';
    end if;
    select coalesce(array_agg(id), '{}') into children from public.child_profiles where family_id = p_family;
  else
    if not exists (
      select 1 from public.deletion_requests
       where family_id = p_family and target_child_id = p_child and status in ('requested', 'processing')
    ) then
      raise exception 'no open deletion request for this child' using errcode = 'P0001';
    end if;
    children := array[p_child];
  end if;

  perform set_config('pencillift.purging', 'on', true);

  select coalesce(array_agg(storage_path), '{}') into paths
    from public.source_pages where family_id = p_family and child_id = any(children);
  select coalesce(array_agg(c::text), '{}') into child_texts from unnest(children) as c;
  select coalesce(array_agg(id::text), '{}') into assignment_ids
    from public.assignments where family_id = p_family and child_id = any(children);
  -- A family-wide export (child_id null) holds every child's records, so a child purge removes it
  -- too (the parent can request a new one). The API removes the files before calling this.
  select coalesce(array_agg(id::text), '{}') into export_ids
    from public.data_exports
   where family_id = p_family and (p_child is null or child_id = any(children) or child_id is null);

  -- Queue rows and payloads (spec P4 "queue payloads"): every job of the family (family purge) or
  -- referring to the child, its scans or its exports (child purge). The deletion purge jobs stay:
  -- their payload is the deletion request id only.
  delete from public.jobs j
   where j.family_id = p_family and j.kind <> 'deletion_purge'
     and (p_child is null
          or j.child_id = any(children)
          or j.payload ->> 'childId' = any(child_texts)
          or j.payload ->> 'assignmentId' = any(assignment_ids)
          or j.payload ->> 'exportId' = any(export_ids)
          or exists (select 1 from unnest(child_texts) c where strpos(j.payload::text, c) > 0));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('jobs', n);

  -- Homework and grading
  delete from public.child_feedback where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('child_feedback', n);
  delete from public.safety_reports where family_id = p_family and (child_id = any(children) or (p_child is null));
  delete from public.question_results where family_id = p_family and child_id = any(children);
  delete from private.question_solutions s using public.extracted_questions q
   where s.question_id = q.id and q.family_id = p_family and q.child_id = any(children);
  delete from public.extracted_questions where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('extracted_questions', n);
  delete from public.source_pages where family_id = p_family and child_id = any(children);
  -- The allowance ledger is kept with the child pseudonymised: it keeps counting toward the
  -- family's period (spec P11: removing profiles must not reset usage or farm allowances).
  update public.usage_reservations set child_id = null
   where family_id = p_family and child_id = any(children);
  delete from public.assignments where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('assignments', n);
  -- Owner cost records stay for spend accounting, no longer keyed to the child.
  update public.ai_usage_events set child_id = null
   where family_id = p_family and child_id = any(children);

  -- Learning evidence and practice
  delete from public.attempt_overrides o using public.attempts a
   where o.attempt_id = a.id and a.family_id = p_family and a.child_id = any(children);
  delete from public.attempts where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('attempts', n);
  delete from public.target_answer_attempts where family_id = p_family and child_id = any(children);
  delete from private.practice_item_keys k using public.practice_items i
   where k.item_id = i.id and i.family_id = p_family and i.child_id = any(children);
  delete from public.practice_items where family_id = p_family and child_id = any(children);
  delete from public.practice_sets where family_id = p_family and child_id = any(children);
  delete from public.test_dates where family_id = p_family and child_id = any(children);
  delete from public.study_materials where family_id = p_family and child_id = any(children);
  delete from public.child_subjects where family_id = p_family and child_id = any(children);
  delete from public.learning_schedules where family_id = p_family and child_id = any(children);

  -- Rewards
  delete from public.points_ledger where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('points_ledger', n);
  delete from public.point_balances where family_id = p_family and child_id = any(children);
  delete from public.reward_redemptions where family_id = p_family and child_id = any(children);
  delete from public.rewards where family_id = p_family and (child_id = any(children) or p_child is null);

  -- Devices, sessions and notifications
  delete from private.push_tokens t using public.notification_devices d
   where t.device_id = d.id and d.family_id = p_family and (d.child_id = any(children) or p_child is null);
  delete from public.notification_deliveries x using public.notification_devices d
   where x.device_id = d.id and d.family_id = p_family and (d.child_id = any(children) or p_child is null);
  delete from public.notification_devices where family_id = p_family and (child_id = any(children) or p_child is null);
  delete from private.child_refresh_tokens t using public.child_sessions s
   where t.session_id = s.id and s.family_id = p_family and s.child_id = any(children);
  delete from public.child_sessions where family_id = p_family and child_id = any(children);
  delete from public.child_devices where family_id = p_family and child_id = any(children);
  delete from private.child_pairing_codes where family_id = p_family and child_id = any(children);
  delete from private.child_pins where child_id = any(children);
  delete from public.child_slot_assignments where family_id = p_family and child_id = any(children);
  delete from public.data_exports where family_id = p_family and id::text = any(export_ids);

  delete from public.child_profiles where family_id = p_family and id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('child_profiles', n);

  if p_child is null then
    delete from private.guardian_invitation_tokens t using public.guardian_invitations i
     where t.invitation_id = i.id and i.family_id = p_family;
    delete from public.guardian_invitations where family_id = p_family;
    delete from public.reward_rules where family_id = p_family;
    -- Support cases (0810) are parent account text and go with the family; a child-scoped purge
    -- keeps them (they hold no child data). Counted so the purge report shows them.
    delete from public.support_case_messages m using public.support_cases c
     where m.case_id = c.id and c.family_id = p_family;
    delete from public.support_cases where family_id = p_family;
    get diagnostics n = row_count; counts := counts || jsonb_build_object('support_cases', n);
    delete from public.family_school_designations where family_id = p_family
      and not exists (select 1 from public.donation_accruals a where a.family_id = p_family);
    update public.family_memberships set status = 'revoked', revoked_at = coalesce(revoked_at, now())
     where family_id = p_family and status = 'active';
    update public.families set display_name = 'Deleted family' where id = p_family;
  end if;

  update public.deletion_requests
     set status = 'completed', completed_at = now(), purge_report = counts || jsonb_build_object('storage_objects', cardinality(paths))
   where family_id = p_family and status in ('requested', 'processing')
     and (p_child is null or target_child_id = p_child);

  insert into public.audit_events (family_id, actor_kind, action, target_type, target_id, metadata)
    values (p_family, 'system', 'deletion.purged', case when p_child is null then 'family' else 'child' end,
            coalesce(p_child, p_family)::text, counts);

  return jsonb_build_object('counts', counts, 'storagePaths', to_jsonb(paths));
end
$$;


--
-- Name: purge_in_progress(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.purge_in_progress() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(current_setting('pencillift.purging', true), '') = 'on'
     and current_user not in ('anon', 'authenticated', 'pl_child', 'service_role')
$$;


--
-- Name: rate_limit_hit(text, integer, integer, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer, p_now timestamp with time zone) RETURNS TABLE(allowed boolean, hits integer, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: rate_limit_release(text, integer, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.rate_limit_release(p_key text, p_window_seconds integer, p_now timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  window_begin timestamptz := to_timestamp(floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds);
begin
  update private.rate_limit_buckets b
     set hits = greatest(b.hits - 1, 0)
   where b.bucket_key = p_key and b.window_start = window_begin;
end
$$;


--
-- Name: rate_limit_reserve_shared(text, text, integer, integer, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.rate_limit_reserve_shared(p_shared_key text, p_client_key text, p_limit integer, p_window_seconds integer, p_now timestamp with time zone) RETURNS TABLE(allowed boolean, exhausted boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: identity_declarations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_declarations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    adult_user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_reference text,
    document_is_government_id boolean NOT NULL,
    document_holder_is_adult boolean NOT NULL,
    holder_attestation_version text,
    holder_attested_at timestamp with time zone,
    adult_declared boolean GENERATED ALWAYS AS ((document_is_government_id AND document_holder_is_adult AND (holder_attestation_version IS NOT NULL))) STORED NOT NULL,
    failure_code text,
    is_test_provider boolean NOT NULL,
    images_discarded_at timestamp with time zone NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_declarations_attestation_complete CHECK ((((holder_attestation_version IS NULL) AND (holder_attested_at IS NULL)) OR ((holder_attestation_version IS NOT NULL) AND (holder_attested_at IS NOT NULL)))),
    CONSTRAINT identity_declarations_established_names_no_failure CHECK (((NOT adult_declared) OR (failure_code IS NULL))),
    CONSTRAINT identity_declarations_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[A-Z][A-Z0-9_]{2,39}$'::text))),
    CONSTRAINT identity_declarations_unestablished_says_why CHECK ((adult_declared OR (failure_code IS NOT NULL)))
);


--
-- Name: record_identity_declaration(uuid, uuid, text, text, boolean, boolean, text, text, boolean, text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.record_identity_declaration(p_family uuid, p_adult uuid, p_provider text, p_provider_reference text, p_document_is_government_id boolean, p_document_holder_is_adult boolean, p_holder_attestation_version text, p_failure_code text, p_is_test_provider boolean, p_policy_version text, p_now timestamp with time zone) RETURNS public.identity_declarations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  rec public.identity_declarations;
begin
  insert into public.identity_declarations (
    family_id, adult_user_id, provider, provider_reference,
    document_is_government_id, document_holder_is_adult,
    holder_attestation_version, holder_attested_at,
    failure_code, is_test_provider, images_discarded_at, checked_at)
  values (
    p_family, p_adult, p_provider, p_provider_reference,
    p_document_is_government_id, p_document_holder_is_adult,
    p_holder_attestation_version,
    -- NULL exactly when there is no declaration, which the paired constraint enforces.
    case when p_holder_attestation_version is null then null else p_now end,
    p_failure_code, p_is_test_provider, p_now, p_now)
  returning * into rec;

  if rec.adult_declared then
    insert into public.consent_records (
      family_id, adult_user_id, provider, provider_reference, method, purpose,
      policy_version, scope, status, is_test_provider, verified_at)
    values (
      p_family, p_adult, p_provider, p_provider_reference,
      -- 'document_only' names HOW this adult was established, so an audit reading consent_records
      -- alone can tell this standard from a face-matched one without joining back.
      'document_only', 'child_data_processing', p_policy_version,
      jsonb_build_object(
        'identityDeclarationId', rec.id::text,
        'holderAttestationVersion', rec.holder_attestation_version,
        'basis', 'declared'),
      'verified', p_is_test_provider, p_now);
  end if;

  insert into public.audit_events (
    family_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (
    p_family, p_adult, 'parent',
    case when rec.adult_declared then 'identity.declared' else 'identity.declaration_refused' end,
    'adult', p_adult::text);

  return rec;
end
$$;


--
-- Name: identity_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    adult_user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_reference text,
    method text NOT NULL,
    document_is_government_id boolean NOT NULL,
    document_holder_is_adult boolean NOT NULL,
    face_match text NOT NULL,
    adult_confirmed boolean GENERATED ALWAYS AS ((document_is_government_id AND document_holder_is_adult AND (face_match = 'matched'::text))) STORED NOT NULL,
    failure_code text,
    is_test_provider boolean NOT NULL,
    images_discarded_at timestamp with time zone NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_verifications_check CHECK (((NOT adult_confirmed) OR (failure_code IS NULL))),
    CONSTRAINT identity_verifications_check1 CHECK ((adult_confirmed OR (failure_code IS NOT NULL))),
    CONSTRAINT identity_verifications_face_match_check CHECK ((face_match = ANY (ARRAY['matched'::text, 'not_matched'::text, 'inconclusive'::text, 'not_attempted'::text, 'refused'::text, 'error'::text]))),
    CONSTRAINT identity_verifications_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code ~ '^[A-Z][A-Z0-9_]{2,39}$'::text))),
    CONSTRAINT identity_verifications_method_check CHECK ((method = ANY (ARRAY['document_and_selfie'::text, 'document_only'::text, 'vendor_hosted'::text])))
);


--
-- Name: record_identity_verification(uuid, uuid, text, text, text, boolean, boolean, text, text, boolean, text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.record_identity_verification(p_family uuid, p_adult uuid, p_provider text, p_provider_reference text, p_method text, p_document_is_government_id boolean, p_document_holder_is_adult boolean, p_face_match text, p_failure_code text, p_is_test_provider boolean, p_policy_version text, p_now timestamp with time zone) RETURNS public.identity_verifications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  rec public.identity_verifications;
begin
  insert into public.identity_verifications (
    family_id, adult_user_id, provider, provider_reference, method,
    document_is_government_id, document_holder_is_adult, face_match,
    failure_code, is_test_provider, images_discarded_at, checked_at)
  values (
    p_family, p_adult, p_provider, p_provider_reference, p_method,
    p_document_is_government_id, p_document_holder_is_adult, p_face_match,
    p_failure_code, p_is_test_provider, p_now, p_now)
  returning * into rec;

  if rec.adult_confirmed then
    -- The consent row is what the rest of the product reads (services/consent.ts
    -- consentAllowsChildAccess, and through it the pairing-code route, the job gates and child
    -- access). method names HOW the adult was verified so an audit can tell a document check from a
    -- hosted vendor flow; provider carries the adapter that ran it.
    insert into public.consent_records (
      family_id, adult_user_id, provider, provider_reference, method, purpose,
      policy_version, scope, status, is_test_provider, verified_at)
    values (
      p_family, p_adult, p_provider, p_provider_reference, p_method, 'child_data_processing',
      p_policy_version,
      jsonb_build_object('identityVerificationId', rec.id::text),
      'verified', p_is_test_provider, p_now);
  end if;

  insert into public.audit_events (
    family_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (
    p_family, p_adult, 'parent',
    case when rec.adult_confirmed then 'identity.confirmed' else 'identity.refused' end,
    'adult', p_adult::text);

  return rec;
end
$$;


--
-- Name: refuse_fake_catalog_row(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.refuse_fake_catalog_row() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_fake boolean;
begin
  if app.database_environment() is distinct from 'production' then
    return new;
  end if;
  -- One branch per table: plpgsql plans only the branch that runs for this table's row type.
  if tg_table_name = 'resource_catalog' then
    v_fake := app.resource_is_fake(new);
  elsif tg_table_name = 'monetization_approvals' then
    v_fake := app.approval_is_fake(new);
  elsif tg_table_name = 'store_product_mappings' then
    v_fake := app.store_product_is_fake(new);
  elsif tg_table_name = 'store_feature_mappings' then
    v_fake := app.store_feature_is_fake(new);
  elsif tg_table_name = 'provider_offer_mappings' then
    v_fake := app.provider_offer_is_fake(new);
  elsif tg_table_name = 'sponsors' then
    v_fake := app.sponsor_is_fake(new);
  elsif tg_table_name = 'sponsor_campaigns' then
    v_fake := app.sponsor_campaign_is_fake(new);
  else
    raise exception 'refuse_fake_catalog_row is not defined for %.%', tg_table_schema, tg_table_name;
  end if;
  if v_fake then
    raise exception 'fixture or fake catalog data is refused in the production database (%.%)',
      tg_table_schema, tg_table_name
      using errcode = 'P0001',
            hint = 'Labeled fixtures, reserved test hosts and unchecked availability belong to development and test databases.';
  end if;
  return new;
end
$$;


--
-- Name: request_instant(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.request_instant() RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(nullif(current_setting('pencillift.request_now', true), '')::timestamptz, now())
$$;


--
-- Name: reset_link_check_on_url_change(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reset_link_check_on_url_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.merchant_url is distinct from old.merchant_url then
    new.availability := 'unknown';
    new.last_link_check_status := null;
    new.last_link_check_at := null;
  end if;
  return new;
end
$$;


--
-- Name: resource_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stable_key text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    subjects text[] NOT NULL,
    grade_min smallint NOT NULL,
    grade_max smallint NOT NULL,
    kind text NOT NULL,
    merchant text NOT NULL,
    merchant_url text,
    image_asset_ref text,
    image_license_ref text,
    availability text DEFAULT 'unknown'::text NOT NULL,
    last_link_check_at timestamp with time zone,
    last_link_check_status text,
    status text DEFAULT 'draft'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_catalog_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'unavailable'::text, 'unknown'::text]))),
    CONSTRAINT resource_catalog_check CHECK ((grade_max >= grade_min)),
    CONSTRAINT resource_catalog_check1 CHECK (((merchant = 'none'::text) = (merchant_url IS NULL))),
    CONSTRAINT resource_catalog_check2 CHECK (((merchant <> 'amazon'::text) OR (merchant_url ~ '^https://www\.amazon\.com/dp/[A-Z0-9]{10}$'::text))),
    CONSTRAINT resource_catalog_check3 CHECK (((merchant <> 'other'::text) OR (merchant_url !~* '^https://([a-z0-9-]+\.)*amazon\.'::text))),
    CONSTRAINT resource_catalog_check4 CHECK (((kind <> ALL (ARRAY['parent_exercise'::text, 'in_app_practice'::text])) OR (merchant = 'none'::text))),
    CONSTRAINT resource_catalog_check5 CHECK (((image_asset_ref IS NULL) OR (image_license_ref IS NOT NULL))),
    CONSTRAINT resource_catalog_check6 CHECK (((status <> 'approved'::text) OR ((reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT resource_catalog_description_check CHECK ((((char_length(btrim(description)) >= 10) AND (char_length(btrim(description)) <= 600)) AND (description !~ '[<>]'::text))),
    CONSTRAINT resource_catalog_grade_max_check CHECK (((grade_max >= 0) AND (grade_max <= 12))),
    CONSTRAINT resource_catalog_grade_min_check CHECK (((grade_min >= 0) AND (grade_min <= 12))),
    CONSTRAINT resource_catalog_image_asset_ref_check CHECK (((image_asset_ref ~ '^[a-z0-9][a-z0-9/_.-]{2,200}$'::text) AND (image_asset_ref !~ '\.\.'::text))),
    CONSTRAINT resource_catalog_image_license_ref_check CHECK (((char_length(btrim(image_license_ref)) >= 6) AND (char_length(btrim(image_license_ref)) <= 200))),
    CONSTRAINT resource_catalog_kind_check CHECK ((kind = ANY (ARRAY['workbook'::text, 'flashcards'::text, 'manipulative'::text, 'parent_exercise'::text, 'in_app_practice'::text]))),
    CONSTRAINT resource_catalog_last_link_check_status_check CHECK ((last_link_check_status = ANY (ARRAY['ok'::text, 'broken'::text, 'error'::text, 'skipped'::text]))),
    CONSTRAINT resource_catalog_merchant_check CHECK ((merchant = ANY (ARRAY['amazon'::text, 'other'::text, 'none'::text]))),
    CONSTRAINT resource_catalog_merchant_url_check CHECK (((char_length(merchant_url) <= 500) AND (merchant_url ~ '^https://[a-z0-9.-]+(/[^\s?#<>"''`]*)?$'::text))),
    CONSTRAINT resource_catalog_skills_check CHECK (((cardinality(skills) <= 20) AND ((cardinality(skills) = 0) OR app.all_match(skills, '^[a-z0-9][a-z0-9_.:-]{0,63}$'::text)))),
    CONSTRAINT resource_catalog_stable_key_check CHECK ((stable_key ~ '^[a-z0-9][a-z0-9-]{2,63}$'::text)),
    CONSTRAINT resource_catalog_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'retired'::text]))),
    CONSTRAINT resource_catalog_subjects_check CHECK (((cardinality(subjects) > 0) AND (subjects <@ ARRAY['math'::text, 'reading'::text, 'spelling_vocabulary'::text, 'grammar_writing'::text, 'science'::text, 'social_studies'::text]))),
    CONSTRAINT resource_catalog_title_check CHECK ((((char_length(btrim(title)) >= 2) AND (char_length(btrim(title)) <= 120)) AND (title !~ '[<>]'::text)))
);


--
-- Name: resource_is_fake(public.resource_catalog); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.resource_is_fake(p_row public.resource_catalog) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.status <> 'retired' and (
    p_row.stable_key like 'fixture-%'
    or app.is_fixture_label(p_row.image_license_ref)
    or app.is_reserved_test_url(p_row.merchant_url)
    or (p_row.merchant_url is not null and p_row.availability = 'available'
        and p_row.last_link_check_status is distinct from 'ok')
  )
$$;


--
-- Name: reveals_small_group(bigint[]); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reveals_small_group(p_cents bigint[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select exists (
    select 1
      from unnest(p_cents || 0::bigint) x
     cross join unnest(p_cents || 0::bigint) y
     where abs(x - y) between 1 and 499
  )
$$;


--
-- Name: schedule_late_page_removal(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.schedule_late_page_removal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.storage_removed_at is not null
     and new.storage_removed_at is distinct from old.storage_removed_at
     and app.upload_window_open(new.assignment_id) then
    insert into private.storage_removals (storage_path, remove_after, reason)
      values (new.storage_path, new.storage_removed_at + app.late_upload_window(), 'removal_late_upload');
  end if;
  return new;
end
$$;


--
-- Name: school_month_donation_figures(uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.school_month_donation_figures(p_school uuid, p_month text, OUT signups bigint, OUT eligible bigint, OUT accrued_cents bigint, OUT paid_cents bigint) RETURNS record
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
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


--
-- Name: sponsor_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sponsor_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sponsor_id uuid NOT NULL,
    creative_id uuid NOT NULL,
    name text NOT NULL,
    placement text NOT NULL,
    platforms text[] NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    impression_cap integer NOT NULL,
    fee_model text NOT NULL,
    contracted_fee_cents integer DEFAULT 0 NOT NULL,
    invoice_status text DEFAULT 'not_invoiced'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    paused_reason text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sponsor_campaigns_check CHECK ((ends_at > starts_at)),
    CONSTRAINT sponsor_campaigns_check1 CHECK (((fee_model = 'fixed_fee'::text) = (contracted_fee_cents > 0))),
    CONSTRAINT sponsor_campaigns_check2 CHECK (((status <> 'paused'::text) OR (paused_reason IS NOT NULL))),
    CONSTRAINT sponsor_campaigns_contracted_fee_cents_check CHECK ((contracted_fee_cents >= 0)),
    CONSTRAINT sponsor_campaigns_fee_model_check CHECK ((fee_model = ANY (ARRAY['fixed_fee'::text, 'none'::text]))),
    CONSTRAINT sponsor_campaigns_impression_cap_check CHECK ((impression_cap > 0)),
    CONSTRAINT sponsor_campaigns_invoice_status_check CHECK ((invoice_status = ANY (ARRAY['not_invoiced'::text, 'invoiced'::text, 'paid'::text, 'void'::text]))),
    CONSTRAINT sponsor_campaigns_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120))),
    CONSTRAINT sponsor_campaigns_paused_reason_check CHECK ((char_length(paused_reason) <= 200)),
    CONSTRAINT sponsor_campaigns_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text]))),
    CONSTRAINT sponsor_campaigns_platforms_check CHECK (((cardinality(platforms) > 0) AND (platforms <@ ARRAY['ios'::text, 'android'::text, 'web'::text]))),
    CONSTRAINT sponsor_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'scheduled'::text, 'active'::text, 'paused'::text, 'ended'::text, 'rejected'::text])))
);


--
-- Name: sponsor_campaign_is_fake(public.sponsor_campaigns); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.sponsor_campaign_is_fake(p_row public.sponsor_campaigns) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select p_row.status in ('in_review', 'scheduled', 'active', 'paused') and (
    exists (select 1 from public.sponsor_creatives cr
             where cr.id = p_row.creative_id and app.sponsor_creative_is_fake(cr))
    or exists (select 1 from public.sponsors s, unnest(s.allowed_domains) d
                where s.id = p_row.sponsor_id and app.is_reserved_test_domain(d))
  )
$$;


--
-- Name: sponsor_creatives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sponsor_creatives (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sponsor_id uuid NOT NULL,
    version integer NOT NULL,
    sponsor_name text NOT NULL,
    headline text NOT NULL,
    body text NOT NULL,
    cta_label text NOT NULL,
    destination_url text NOT NULL,
    image_asset_ref text,
    image_license_ref text,
    review_status text DEFAULT 'draft'::text NOT NULL,
    created_by uuid NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    self_reviewed boolean DEFAULT false NOT NULL,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sponsor_creatives_body_check CHECK ((((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 240)) AND (char_length(body) <= 240))),
    CONSTRAINT sponsor_creatives_body_check1 CHECK ((body !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]'::text)),
    CONSTRAINT sponsor_creatives_check CHECK (((image_asset_ref IS NULL) OR (image_license_ref IS NOT NULL))),
    CONSTRAINT sponsor_creatives_check1 CHECK (((review_status = ANY (ARRAY['approved'::text, 'rejected'::text])) = ((reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT sponsor_creatives_cta_label_check CHECK ((((char_length(btrim(cta_label)) >= 1) AND (char_length(btrim(cta_label)) <= 24)) AND (char_length(cta_label) <= 24))),
    CONSTRAINT sponsor_creatives_cta_label_check1 CHECK ((cta_label !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]'::text)),
    CONSTRAINT sponsor_creatives_destination_url_check CHECK (((char_length(destination_url) <= 500) AND (destination_url ~ '^https://[a-z0-9.-]+(/[^\s<>"''`]*)?$'::text))),
    CONSTRAINT sponsor_creatives_headline_check CHECK ((((char_length(btrim(headline)) >= 1) AND (char_length(btrim(headline)) <= 80)) AND (char_length(headline) <= 80))),
    CONSTRAINT sponsor_creatives_headline_check1 CHECK ((headline !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]'::text)),
    CONSTRAINT sponsor_creatives_image_asset_ref_check CHECK (((image_asset_ref ~ '^[a-z0-9][a-z0-9/_.-]{2,200}$'::text) AND (image_asset_ref !~ '\.\.'::text))),
    CONSTRAINT sponsor_creatives_image_license_ref_check CHECK (((char_length(btrim(image_license_ref)) >= 6) AND (char_length(btrim(image_license_ref)) <= 200))),
    CONSTRAINT sponsor_creatives_review_note_check CHECK ((char_length(review_note) <= 500)),
    CONSTRAINT sponsor_creatives_review_status_check CHECK ((review_status = ANY (ARRAY['draft'::text, 'in_review'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT sponsor_creatives_sponsor_name_check CHECK ((((char_length(sponsor_name) >= 2) AND (char_length(sponsor_name) <= 120)) AND (sponsor_name !~ '[<>]'::text))),
    CONSTRAINT sponsor_creatives_version_check CHECK ((version >= 1))
);


--
-- Name: sponsor_creative_is_fake(public.sponsor_creatives); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.sponsor_creative_is_fake(p_row public.sponsor_creatives) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select app.is_reserved_test_url(p_row.destination_url) or app.is_fixture_label(p_row.image_license_ref)
$$;


--
-- Name: sponsors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sponsors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_name text NOT NULL,
    contact_ref text,
    allowed_domains text[] NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sponsors_allowed_domains_check CHECK ((((cardinality(allowed_domains) >= 1) AND (cardinality(allowed_domains) <= 20)) AND app.all_match(allowed_domains, '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'::text))),
    CONSTRAINT sponsors_business_name_check CHECK ((((char_length(business_name) >= 2) AND (char_length(business_name) <= 120)) AND (business_name !~ '[<>]'::text))),
    CONSTRAINT sponsors_contact_ref_check CHECK ((char_length(contact_ref) <= 200)),
    CONSTRAINT sponsors_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])))
);


--
-- Name: sponsor_is_fake(public.sponsors); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.sponsor_is_fake(p_row public.sponsors) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.status = 'active'
    and exists (select 1 from unnest(p_row.allowed_domains) d where app.is_reserved_test_domain(d))
$$;


--
-- Name: stamp_uploads_closed(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.stamp_uploads_closed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.status in ('draft', 'uploading') then
    new.uploads_closed_at := null;
  elsif tg_op = 'INSERT' then
    new.uploads_closed_at := coalesce(new.uploads_closed_at, now());
  elsif old.status in ('draft', 'uploading') then
    new.uploads_closed_at := now();
  end if;
  return new;
end
$$;


--
-- Name: store_feature_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_feature_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    product_id text NOT NULL,
    environment text NOT NULL,
    feature text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_feature_mappings_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT store_feature_mappings_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT store_feature_mappings_feature_check CHECK ((feature = 'ad_free'::text)),
    CONSTRAINT store_feature_mappings_product_id_check CHECK (((char_length(product_id) >= 1) AND (char_length(product_id) <= 200)))
);


--
-- Name: store_feature_is_fake(public.store_feature_mappings); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.store_feature_is_fake(p_row public.store_feature_mappings) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.active and app.is_fixture_label(p_row.product_id)
$$;


--
-- Name: store_product_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_product_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    product_id text NOT NULL,
    base_plan_id text DEFAULT ''::text NOT NULL,
    environment text NOT NULL,
    paid_slots smallint NOT NULL,
    store_price_cents integer,
    currency text DEFAULT 'USD'::text NOT NULL,
    price_verified_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT store_product_mappings_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT store_product_mappings_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT store_product_mappings_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT store_product_mappings_paid_slots_check CHECK (((paid_slots >= 1) AND (paid_slots <= 12))),
    CONSTRAINT store_product_mappings_product_id_check CHECK (((char_length(product_id) >= 1) AND (char_length(product_id) <= 200))),
    CONSTRAINT store_product_mappings_store_price_cents_check CHECK ((store_price_cents > 0))
);


--
-- Name: store_product_is_fake(public.store_product_mappings); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.store_product_is_fake(p_row public.store_product_mappings) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_row.active
    and (app.is_fixture_label(p_row.product_id) or app.is_fixture_label(p_row.base_plan_id))
$$;


--
-- Name: text_has_control_character(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.text_has_control_character(p_text text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(p_text ~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]', false)
$$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: try_uuid(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.try_uuid(p text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$_$;


--
-- Name: upload_window_open(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.upload_window_open(p_assignment uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce((
    select a.status in ('draft', 'uploading')
        or coalesce(a.uploads_closed_at, a.updated_at) > now() - app.late_upload_window()
      from public.assignments a
     where a.id = p_assignment), false)
$$;


--
-- Name: adult_identity_basis(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.adult_identity_basis(p_adult uuid) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case
    when exists (select 1 from public.identity_verifications
                  where adult_user_id = p_adult and adult_confirmed) then 'verified'
    when exists (select 1 from public.identity_declarations
                  where adult_user_id = p_adult and adult_declared) then 'declared'
    else null
  end
$$;


--
-- Name: adult_identity_confirmed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.adult_identity_confirmed(p_adult uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.identity_verifications
     where adult_user_id = p_adult and adult_confirmed)
$$;


--
-- Name: adult_identity_established(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.adult_identity_established(p_adult uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select public.adult_identity_basis(p_adult) is not null
$$;


--
-- Name: reward_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    reward_id uuid NOT NULL,
    point_cost integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    fulfilled_at timestamp with time zone,
    cancelled_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_redemptions_cancelled_by_check CHECK ((cancelled_by = ANY (ARRAY['child'::text, 'parent'::text]))),
    CONSTRAINT reward_redemptions_point_cost_check CHECK ((point_cost > 0)),
    CONSTRAINT reward_redemptions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'fulfilled'::text, 'declined'::text, 'cancelled'::text])))
);


--
-- Name: child_cancel_reward_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.child_cancel_reward_request(p_request uuid) RETURNS public.reward_redemptions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  me uuid := app.current_child_id();
  req public.reward_redemptions;
begin
  if me is null then
    raise exception 'child session required' using errcode = '42501';
  end if;
  select * into req from public.reward_redemptions where id = p_request and child_id = me for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if req.state = 'cancelled' then
    return req;
  end if;
  if req.state <> 'pending' then
    raise exception 'only pending requests can be cancelled by a child' using errcode = 'P0001';
  end if;
  update public.reward_redemptions set state = 'cancelled', cancelled_by = 'child'
   where id = p_request returning * into req;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind)
    values (req.family_id, me, 'redemption_release', req.point_cost, 'redeem:' || p_request || ':release', p_request, 'child')
    on conflict (child_id, idempotency_key) do nothing;
  return req;
end
$$;


--
-- Name: child_report_content(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.child_report_content(p_category text, p_question uuid DEFAULT NULL::uuid, p_feedback uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  me uuid := app.current_child_id();
  fam uuid := app.current_child_family_id();
  about uuid;
  held boolean;
  report_id uuid;
begin
  if me is null then
    raise exception 'child session required' using errcode = '42501';
  end if;
  if p_question is not null and not exists (
      select 1 from public.extracted_questions where id = p_question and child_id = me) then
    raise exception 'question not found' using errcode = 'P0002';
  end if;
  if p_feedback is not null and not exists (
      select 1 from public.child_feedback where id = p_feedback and child_id = me) then
    raise exception 'feedback not found' using errcode = 'P0002';
  end if;
  -- The named feedback row's own question counts too: the two ids are each checked as the child's,
  -- not as belonging together.
  about := (select question_id from public.child_feedback where id = p_feedback);
  held := exists (
    select 1 from public.safety_reports s
     where s.question_id in (p_question, about) and s.reporter_kind = 'system' and not s.family_visible);
  insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id, feedback_id, family_visible)
    values (fam, me, 'child', p_category, p_question, p_feedback, not held)
    returning id into report_id;
  return report_id;
end
$$;


--
-- Name: child_request_reward(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.child_request_reward(p_reward uuid, p_request uuid) RETURNS public.reward_redemptions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  me uuid := app.current_child_id();
  fam uuid := app.current_child_family_id();
  r public.rewards;
  existing public.reward_redemptions;
  created public.reward_redemptions;
begin
  if me is null then
    raise exception 'child session required' using errcode = '42501';
  end if;
  -- Idempotent retry of the same request id.
  select * into existing from public.reward_redemptions where id = p_request;
  if found then
    if existing.child_id <> me then
      raise exception 'request id already used' using errcode = 'P0001';
    end if;
    return existing;
  end if;
  select * into r from public.rewards
   where id = p_reward and family_id = fam and active and (child_id is null or child_id = me);
  if not found then
    raise exception 'reward not available' using errcode = 'P0002';
  end if;
  insert into public.reward_redemptions (id, family_id, child_id, reward_id, point_cost)
    values (p_request, fam, me, r.id, r.point_cost)
    returning * into created;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind)
    values (fam, me, 'redemption_reserve', -r.point_cost, 'redeem:' || p_request || ':reserve', p_request, 'child');
  return created;
end
$$;


--
-- Name: create_family(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_family(p_display_name text, p_timezone text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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


--
-- Name: parent_adjust_points(uuid, integer, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parent_adjust_points(p_child uuid, p_points integer, p_reason text, p_adjustment uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  fam uuid;
  entry_id bigint;
begin
  select family_id into fam from public.child_profiles where id = p_child;
  if fam is null or not app.is_family_member(fam) then
    raise exception 'child not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  if p_points = 0 then
    raise exception 'adjustment must be non-zero' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, reason, actor_kind, actor_user_id)
    values (fam, p_child, 'adjustment', p_points, 'adjust:' || p_adjustment, p_reason, 'parent', uid)
    on conflict (child_id, idempotency_key) do nothing
    returning id into entry_id;
  return entry_id;
end
$$;


--
-- Name: parent_assignment_solutions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parent_assignment_solutions(p_assignment uuid) RETURNS TABLE(question_id uuid, question_number text, correct_answer text, worked_solution text, rubric jsonb, misconception text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  fam uuid;
begin
  select a.family_id into fam from public.assignments a where a.id = p_assignment and a.status <> 'deleted';
  if fam is null or not app.is_family_member(fam) then
    raise exception 'assignment not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  return query
    select q.id, q.question_number, s.correct_answer, s.worked_solution, s.rubric, s.misconception
      from public.extracted_questions q
      join private.question_solutions s on s.question_id = q.id
     where q.assignment_id = p_assignment
     order by q.question_number;
end
$$;


--
-- Name: parent_decide_reward(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parent_decide_reward(p_request uuid, p_action text) RETURNS public.reward_redemptions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  req public.reward_redemptions;
  target text;
begin
  select * into req from public.reward_redemptions where id = p_request for update;
  if not found or not app.is_family_member(req.family_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  target := case p_action
    when 'approve' then 'approved'
    when 'decline' then 'declined'
    when 'fulfill' then 'fulfilled'
    when 'cancel' then 'cancelled'
    else null end;
  if target is null then
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;
  -- Repeating an applied action is a no-op (duplicate callbacks do nothing).
  if req.state = target then
    return req;
  end if;
  update public.reward_redemptions
     set state = target,
         decided_by = coalesce(decided_by, uid),
         decided_at = coalesce(decided_at, now()),
         fulfilled_at = case when target = 'fulfilled' then now() else fulfilled_at end,
         cancelled_by = case when target = 'cancelled' then 'parent' else cancelled_by end
   where id = p_request
   returning * into req;
  if target in ('declined', 'cancelled') then
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind, actor_user_id)
      values (req.family_id, req.child_id, 'redemption_release', req.point_cost,
              'redeem:' || p_request || ':release', p_request, 'parent', uid)
      on conflict (child_id, idempotency_key) do nothing;
  end if;
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (req.family_id, uid, 'parent', 'reward.' || p_action, 'reward_redemption', p_request::text);
  return req;
end
$$;


--
-- Name: question_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.question_results (
    question_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    verdict text NOT NULL,
    route text NOT NULL,
    disagreement boolean DEFAULT false NOT NULL,
    grader_version text NOT NULL,
    graded_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_override_verdict text,
    overridden_by uuid,
    overridden_at timestamp with time zone,
    override_reason text,
    CONSTRAINT question_results_check CHECK (((parent_override_verdict IS NULL) = (overridden_at IS NULL))),
    CONSTRAINT question_results_override_reason_check CHECK ((char_length(override_reason) <= 300)),
    CONSTRAINT question_results_parent_override_verdict_check CHECK ((parent_override_verdict = ANY (ARRAY['correct'::text, 'incorrect'::text, 'unresolved'::text]))),
    CONSTRAINT question_results_route_check CHECK ((route = ANY (ARRAY['deterministic'::text, 'agreement'::text, 'escalated'::text, 'parent_review'::text]))),
    CONSTRAINT question_results_verdict_check CHECK ((verdict = ANY (ARRAY['correct'::text, 'incorrect'::text, 'unresolved'::text, 'unanswered'::text, 'rubric'::text, 'needs_parent_review'::text])))
);


--
-- Name: parent_override_result(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parent_override_result(p_question uuid, p_verdict text, p_reason text) RETURNS public.question_results
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  res public.question_results;
begin
  select * into res from public.question_results where question_id = p_question for update;
  if not found or not app.is_family_member(res.family_id) then
    raise exception 'result not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  if p_verdict not in ('correct', 'incorrect', 'unresolved') then
    raise exception 'invalid verdict' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  update public.question_results
     set parent_override_verdict = p_verdict, overridden_by = uid, overridden_at = now(), override_reason = p_reason
   where question_id = p_question
   returning * into res;
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (res.family_id, uid, 'parent', 'grading.override', 'question', p_question::text,
            jsonb_build_object('verdict', p_verdict));
  return res;
end
$$;


--
-- Name: parent_set_reward_rules(uuid, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.parent_set_reward_rules(p_family uuid, p_attempt_points integer, p_independent_correct_bonus integer, p_set_completion_points integer, p_min_meaningful_response_ms integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  previous public.reward_rules;
  saved public.reward_rules;
begin
  if p_family is null or not app.is_family_member(p_family) then
    raise exception 'family not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  -- Same limits as the table checks, @pencillift/domain/rewards validateRules and the API contract.
  if p_attempt_points is null or p_attempt_points not between 0 and 100
     or p_independent_correct_bonus is null or p_independent_correct_bonus not between 0 and 100
     or p_set_completion_points is null or p_set_completion_points not between 0 and 100 then
    raise exception 'reward points must be whole numbers from 0 to 100' using errcode = '22023';
  end if;
  if p_min_meaningful_response_ms is null
     or p_min_meaningful_response_ms not between 500 and 60000 then
    raise exception 'minimum response time must be from 500 to 60000 ms' using errcode = '22023';
  end if;

  -- Lock the current rules (when the family has saved any) so the audited "before" is exact.
  select * into previous from public.reward_rules where family_id = p_family for update;
  insert into public.reward_rules as r
      (family_id, attempt_points, independent_correct_bonus, set_completion_points, min_meaningful_response_ms)
    values (p_family, p_attempt_points, p_independent_correct_bonus, p_set_completion_points,
            p_min_meaningful_response_ms)
    on conflict (family_id) do update
      set attempt_points = excluded.attempt_points,
          independent_correct_bonus = excluded.independent_correct_bonus,
          set_completion_points = excluded.set_completion_points,
          min_meaningful_response_ms = excluded.min_meaningful_response_ms,
          updated_at = now()
      where (r.attempt_points, r.independent_correct_bonus, r.set_completion_points, r.min_meaningful_response_ms)
            is distinct from
            (excluded.attempt_points, excluded.independent_correct_bonus, excluded.set_completion_points,
             excluded.min_meaningful_response_ms)
    returning * into saved;
  if not found then
    return false; -- identical to the published rules: idempotent retry, nothing to audit
  end if;

  -- Rule values only (family settings, never child content).
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (p_family, uid, 'parent', 'reward_rules.updated', 'reward_rules', p_family::text,
            jsonb_build_object(
              'before', case when previous.family_id is null then null else jsonb_build_object(
                'attemptPoints', previous.attempt_points,
                'independentCorrectBonus', previous.independent_correct_bonus,
                'setCompletionPoints', previous.set_completion_points,
                'minMeaningfulResponseMs', previous.min_meaningful_response_ms) end,
              'after', jsonb_build_object(
                'attemptPoints', saved.attempt_points,
                'independentCorrectBonus', saved.independent_correct_bonus,
                'setCompletionPoints', saved.set_completion_points,
                'minMeaningfulResponseMs', saved.min_meaningful_response_ms)));
  return true;
end
$$;


--
-- Name: deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    scope text NOT NULL,
    child_id uuid,
    requested_by uuid NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    complete_by timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    completed_at timestamp with time zone,
    purge_report jsonb,
    target_child_id uuid,
    CONSTRAINT deletion_requests_check1 CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT deletion_requests_purge_report_json_shape CHECK (((purge_report IS NULL) OR (jsonb_typeof(purge_report) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT deletion_requests_scope_check CHECK ((scope = ANY (ARRAY['family'::text, 'child'::text]))),
    CONSTRAINT deletion_requests_scope_target_check CHECK (((scope = 'child'::text) = (target_child_id IS NOT NULL))),
    CONSTRAINT deletion_requests_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'processing'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: request_deletion(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_deletion(p_family uuid, p_child uuid DEFAULT NULL::uuid) RETURNS public.deletion_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  req public.deletion_requests;
begin
  if not app.is_family_member(p_family) then
    raise exception 'family not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  -- Same rule as the API (routes/privacy.ts): only the owner may delete the whole family; any
  -- guardian may delete a child's data. Enforced here too because this function is callable with
  -- the parent's own JWT (RV-privacy-1: database permissions, not only the API, decide).
  if p_child is null and not app.is_family_owner(p_family) then
    raise exception 'only the family owner can delete the family' using errcode = '42501';
  end if;
  if p_child is not null and not exists (
      select 1 from public.child_profiles where id = p_child and family_id = p_family) then
    raise exception 'child not found' using errcode = 'P0002';
  end if;

  insert into public.deletion_requests (family_id, scope, child_id, target_child_id, requested_by)
    values (p_family, case when p_child is null then 'family' else 'child' end, p_child, p_child, uid)
    returning * into req;

  update public.child_sessions set revoked_at = now(), revoke_reason = 'deletion'
   where family_id = p_family and revoked_at is null and (p_child is null or child_id = p_child);
  update public.child_devices set revoked_at = now()
   where family_id = p_family and revoked_at is null and (p_child is null or child_id = p_child);
  update public.jobs set status = 'cancelled', updated_at = now()
   where family_id = p_family and status in ('queued', 'failed_retryable')
     and (p_child is null or child_id = p_child);
  -- A scan already running for this family/child stops at its next compare-and-set or write
  -- checkpoint (spec P4: deletion stops processing immediately; RV-lead-jobs-ai-3).
  --
  -- HUNT7-D-1: this statement is NOT what stops a family-wide export_build job, and the 'queued'
  -- data_exports statement below is not redundant with it. A family-wide export_build job carries
  -- child_id NULL (routes/privacy.ts inserts the request's childId, null for kind 'family_data'), so
  -- on a CHILD-scope request `child_id = p_child` is NULL and the job is not cancelled; a job already
  -- leased by a worker is 'running' and is not cancelled on either scope.
  update public.assignments set status = 'deleted'
   where family_id = p_family and status <> 'deleted' and (p_child is null or child_id = p_child);
  if p_child is null then
    update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
    -- The adults are released with the tombstone, not by the later purge (DB-R1-02): the family is
    -- already invisible to them, and a still-active membership only blocked a fresh start. This is
    -- also what makes the export DOWNLOAD unreachable on this scope: export-download.ts resolves
    -- currentFamilyId from an active membership before it reads public.data_exports.
    update public.family_memberships set status = 'revoked', revoked_at = now()
     where family_id = p_family and status = 'active';
  else
    -- HUNT5-B-2: the paid slot is freed HERE, with the archive, so every surface that can file a
    -- request frees it — not only the API handler that ran the extra statement.
    --
    -- HUNT6-B-3: the assignment comes BEFORE the profile, which is the order every other writer of
    -- this pair uses. 0890 had them the other way round.
    update public.child_slot_assignments
       set released_at = now(), release_reason = 'archived'
     where family_id = p_family and child_id = p_child and released_at is null;
    update public.child_profiles set status = 'archived', archived_at = now() where id = p_child;
  end if;

  -- HUNT6-B-2: the finished export FILES that hold the deleted data are withdrawn here too, for the
  -- same reason the slot release moved in — `withdrawExports` lived only in the Hono handler while
  -- this function is callable with a parent's own token. Marking the row 'expired' is what makes
  -- apps/api/src/routes/export-download.ts refuse it (it reads status, storage_path and expires_at
  -- and nothing about deletion), so this is the half that must hold on every surface. The
  -- storage_path is deliberately LEFT standing: removing the object is the handler's half and the
  -- purge job's, and a row that still names its file can still be cleaned up later.
  --
  -- Scope matches the handler: all of the family's finished exports for a family deletion; for a
  -- child deletion, that child's exports and every family-wide export (child_id null — family data
  -- and progress files list every child).
  --
  -- The predicate is `status = 'ready'` alone, which is narrower than the handler's copy by one arm:
  -- an already-'expired' row that still names a file. That arm belongs to the handler, because there
  -- `returning id, storage_path` is what feeds the object removal and such a file must still go.
  -- HERE the statement has no `returning` and feeds nothing, and a row that is already 'expired' is
  -- already refused by export-download.ts on its status, so the arm would change no column, withdraw
  -- nothing more, and only take a row lock and write back a row version identical to the one it read.
  -- It is left out: this half is the STATUS, and that row's status is already right.
  update public.data_exports
     set status = 'expired',
         expires_at = least(coalesce(expires_at, now()), now())
   where family_id = p_family
     and status = 'ready'
     and (p_child is null or child_id = p_child or child_id is null);

  -- HUNT7-D-1: and the rows still BEING BUILT, in the same transaction as the request. Without this
  -- the builder's own compare-and-set (`set status = 'ready', storage_path = .., expires_at = ..
  -- where id = .. and status = 'queued'`, apps/api/src/jobs/export-build.ts) published a file composed
  -- from a snapshot taken BEFORE this request committed — see the header: the builder's deletion check
  -- is a plain SELECT under READ COMMITTED, and for family scope it checked nothing at all. 'failed' is
  -- the status for a build that will not produce a file, so this row can never satisfy
  -- export-download.ts and the parent's list does not claim a lapsed link that never existed.
  --
  -- SCOPE, and the one arm this deliberately does NOT take. On a family deletion (p_child is null)
  -- every queued row goes: nothing of this family is deliverable. On a CHILD deletion only that
  -- child's own queued exports go. A FAMILY-WIDE queued export (child_id is null) is LEFT ALONE, and
  -- that is not the false justification 0920 gave — it is a division of labour with the builder, which
  -- is the only party that knows what the bytes contain:
  --
  --   * If the build had not composed yet, it reads this request and leaves the child out, so the file
  --     is correct and the family keeps an export they asked for and are entitled to. Failing it here
  --     would destroy that file for every parent who had a family export in flight, which is the case
  --     spec P4 states explicitly (apps/api/tests/export-build.test.ts: on a child-scope deletion the
  --     family-wide file stays deliverable, carrying the sibling and not the deleted child).
  --   * If the build had ALREADY composed, the file holds the deleted child's rows and must not be
  --     published — and the builder refuses it, because its settle compares the requests open at
  --     publish time against the snapshot the bytes were composed from (`built.excludedChildren`) and
  --     a request missing from that snapshot fails the row.
  --
  -- This statement cannot tell those two apart; the builder can. Taking the broad arm here would trade
  -- a precise refusal for a blunt one and lose the good case, so the narrow scope is deliberate and the
  -- builder carries the rest. A family-scope request needs no such care: its first arm takes every row.
  --
  -- The asymmetry with the 'ready' statement just above — which DOES take `or child_id is null` — is
  -- deliberate and is not an oversight to tidy up. A 'ready' family-wide file was composed before this
  -- request existed, so it certainly holds the deleted child's rows and must be withdrawn. A 'queued'
  -- one may not have been composed at all. Same scope words, different facts.
  update public.data_exports
     set status = 'failed'
   where family_id = p_family
     and status = 'queued'
     and (p_child is null or child_id = p_child);

  -- The purge is enqueued in the same transaction as the tombstone, so a crash can never leave a
  -- deletion request without its durable purge job (spec P4: complete active-store deletion promptly).
  insert into public.jobs (kind, idempotency_key, family_id, child_id, payload)
    values ('deletion_purge', 'deletion:' || req.id::text, p_family, p_child,
            jsonb_build_object('deletionRequestId', req.id));

  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (p_family, uid, 'parent', 'deletion.requested', req.scope, coalesce(p_child, p_family)::text);
  return req;
end
$$;


--
-- Name: request_export(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_export(p_family uuid, p_kind text, p_child uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := app.current_user_id();
  export_id uuid;
begin
  if not app.is_family_member(p_family) then
    raise exception 'family not found' using errcode = 'P0002';
  end if;
  -- Every export contains private family data; answer keys especially (spec P8: distinct protected route).
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  insert into public.data_exports (family_id, requested_by, kind, child_id)
    values (p_family, uid, p_kind, p_child)
    returning id into export_id;
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (p_family, uid, 'parent', 'export.requested', 'export', export_id::text, jsonb_build_object('kind', p_kind));
  return export_id;
end
$$;


--
-- Name: school_month_report(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.school_month_report(p_school uuid, p_month text) RETURNS TABLE(school_id uuid, donation_month text, attributed_signups text, donation_eligible_families text, accrued_cents bigint, paid_cents bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: school_month_report_counts(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.school_month_report_counts(p_school uuid, p_month text, p_zone text DEFAULT 'UTC'::text) RETURNS TABLE(school_id uuid, donation_month text, active_families text, positive_paying_families text, fully_discounted_families text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: adult_unlocks; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.adult_unlocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auth_session_id text NOT NULL,
    method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT adult_unlocks_check CHECK ((expires_at > created_at)),
    CONSTRAINT adult_unlocks_method_check CHECK ((method = ANY (ARRAY['pin'::text, 'biometric'::text, 'password'::text])))
);


--
-- Name: ai_spend_holds; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.ai_spend_holds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_key text NOT NULL,
    micros bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_spend_holds_micros_check CHECK ((micros > 0)),
    CONSTRAINT ai_spend_holds_period_key_check CHECK ((period_key ~ '^[0-9]{4}-[0-9]{2}$'::text))
);


--
-- Name: child_pairing_codes; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.child_pairing_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    code_hash bytea NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    failed_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT child_pairing_codes_check CHECK ((expires_at > created_at))
);


--
-- Name: child_pins; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.child_pins (
    child_id uuid NOT NULL,
    pin_hash text NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT child_pins_failed_attempts_check CHECK ((failed_attempts >= 0))
);


--
-- Name: child_refresh_tokens; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.child_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    replaced_by uuid
);


--
-- Name: deployment; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.deployment (
    singleton boolean DEFAULT true NOT NULL,
    environment text NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deployment_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'test'::text, 'staging'::text, 'production'::text]))),
    CONSTRAINT deployment_singleton_check CHECK (singleton)
);


--
-- Name: ended_auth_sessions; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.ended_auth_sessions (
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    ended_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guardian_invitation_tokens; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.guardian_invitation_tokens (
    invitation_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: known_time_zones; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.known_time_zones (
    name text NOT NULL
);


--
-- Name: parent_pins; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.parent_pins (
    user_id uuid NOT NULL,
    pin_hash text NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parent_pins_failed_attempts_check CHECK ((failed_attempts >= 0))
);


--
-- Name: placement_serves; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.placement_serves (
    serve_token_hash text NOT NULL,
    session_key_hash text NOT NULL,
    campaign_id uuid NOT NULL,
    placement text NOT NULL,
    platform text NOT NULL,
    locale text DEFAULT 'en-US'::text NOT NULL,
    served_at timestamp with time zone NOT NULL,
    viewed_at timestamp with time zone,
    clicked_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    reported_at timestamp with time zone,
    CONSTRAINT placement_serves_locale_check CHECK ((locale ~ '^[a-z]{2}-[A-Z]{2}$'::text)),
    CONSTRAINT placement_serves_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text]))),
    CONSTRAINT placement_serves_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))),
    CONSTRAINT placement_serves_serve_token_hash_check CHECK ((serve_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT placement_serves_session_key_hash_check CHECK ((session_key_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: practice_item_keys; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.practice_item_keys (
    item_id uuid NOT NULL,
    family_id uuid NOT NULL,
    answer_spec jsonb NOT NULL,
    explanation text,
    CONSTRAINT practice_item_keys_answer_spec_json_shape CHECK (((answer_spec IS NULL) OR (jsonb_typeof(answer_spec) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: push_tokens; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.push_tokens (
    device_id uuid NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_tokens_provider_check CHECK ((provider = ANY (ARRAY['expo'::text, 'apns'::text, 'fcm'::text])))
);


--
-- Name: question_solutions; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.question_solutions (
    question_id uuid NOT NULL,
    family_id uuid NOT NULL,
    correct_answer text NOT NULL,
    worked_solution text NOT NULL,
    rubric jsonb,
    misconception text,
    evidence jsonb,
    grading_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    grader_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT question_solutions_evidence_json_shape CHECK (((evidence IS NULL) OR (jsonb_typeof(evidence) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT question_solutions_grading_provenance_json_shape CHECK (((grading_provenance IS NULL) OR (jsonb_typeof(grading_provenance) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT question_solutions_rubric_json_shape CHECK (((rubric IS NULL) OR (jsonb_typeof(rubric) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: rate_limit_buckets; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.rate_limit_buckets (
    bucket_key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    hits integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT rate_limit_buckets_bucket_key_check CHECK (((char_length(bucket_key) >= 3) AND (char_length(bucket_key) <= 300))),
    CONSTRAINT rate_limit_buckets_hits_check CHECK ((hits >= 0))
);


--
-- Name: storage_removals; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.storage_removals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage_path text NOT NULL,
    remove_after timestamp with time zone NOT NULL,
    reason text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_removals_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT storage_removals_reason_check CHECK ((reason = ANY (ARRAY['deletion_late_upload'::text, 'removal_late_upload'::text]))),
    CONSTRAINT storage_removals_storage_path_check CHECK (((char_length(storage_path) >= 1) AND (char_length(storage_path) <= 1024)))
);


--
-- Name: sweep_runs; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.sweep_runs (
    sweep text NOT NULL,
    run_key text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    CONSTRAINT sweep_runs_run_key_check CHECK ((run_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text)),
    CONSTRAINT sweep_runs_sweep_check CHECK ((sweep = 'inactivity'::text))
);


--
-- Name: template_answer_specs; Type: TABLE; Schema: private; Owner: -
--

CREATE TABLE private.template_answer_specs (
    template_id uuid NOT NULL,
    answer_spec jsonb NOT NULL,
    explanation text,
    CONSTRAINT template_answer_specs_answer_spec_json_shape CHECK (((answer_spec IS NULL) OR (jsonb_typeof(answer_spec) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: ad_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid,
    catalog_id uuid,
    category text NOT NULL,
    platform text NOT NULL,
    placement text NOT NULL,
    created_date date NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    CONSTRAINT ad_reports_category_check CHECK ((category = ANY (ARRAY['inappropriate'::text, 'misleading'::text, 'irrelevant'::text, 'other'::text]))),
    CONSTRAINT ad_reports_check CHECK ((num_nonnulls(campaign_id, catalog_id) = 1)),
    CONSTRAINT ad_reports_check1 CHECK (((status = 'reviewed'::text) = ((reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT ad_reports_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text]))),
    CONSTRAINT ad_reports_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))),
    CONSTRAINT ad_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text])))
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['owner_admin'::text, 'support'::text])))
);


--
-- Name: aggregate_ad_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregate_ad_events (
    id bigint NOT NULL,
    campaign_id uuid,
    catalog_id uuid,
    event_date date NOT NULL,
    platform text NOT NULL,
    placement text NOT NULL,
    kind text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    CONSTRAINT aggregate_ad_events_check CHECK ((num_nonnulls(campaign_id, catalog_id) <= 1)),
    CONSTRAINT aggregate_ad_events_count_check CHECK ((count >= 0)),
    CONSTRAINT aggregate_ad_events_kind_check CHECK ((kind = ANY (ARRAY['opportunity'::text, 'served'::text, 'viewable_impression'::text, 'click'::text, 'dismiss'::text, 'report'::text]))),
    CONSTRAINT aggregate_ad_events_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text]))),
    CONSTRAINT aggregate_ad_events_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


--
-- Name: aggregate_ad_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.aggregate_ad_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.aggregate_ad_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_events (
    id bigint NOT NULL,
    family_id uuid,
    child_id uuid,
    stage text NOT NULL,
    model_id text NOT NULL,
    prompt_version text NOT NULL,
    attempt smallint DEFAULT 1 NOT NULL,
    status text NOT NULL,
    input_tokens integer NOT NULL,
    cached_input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer NOT NULL,
    latency_ms integer NOT NULL,
    cost_micros bigint NOT NULL,
    rate_table_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_usage_events_attempt_check CHECK ((attempt >= 1)),
    CONSTRAINT ai_usage_events_cached_input_tokens_check CHECK ((cached_input_tokens >= 0)),
    CONSTRAINT ai_usage_events_check CHECK ((cached_input_tokens <= input_tokens)),
    CONSTRAINT ai_usage_events_cost_micros_check CHECK ((cost_micros >= 0)),
    CONSTRAINT ai_usage_events_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT ai_usage_events_latency_ms_check CHECK ((latency_ms >= 0)),
    CONSTRAINT ai_usage_events_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT ai_usage_events_stage_check CHECK ((stage = ANY (ARRAY['extraction'::text, 'grading'::text, 'verification'::text, 'coaching'::text, 'followup'::text, 'daily_set'::text, 'thursday_bundle'::text, 'semantic_check'::text, 'escalation'::text, 'adult_summary'::text, 'resource_ranking'::text]))),
    CONSTRAINT ai_usage_events_status_check CHECK ((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'timeout'::text, 'rejected_by_validation'::text])))
);


--
-- Name: ai_usage_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ai_usage_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    subject_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    idempotency_key text NOT NULL,
    created_by_kind text NOT NULL,
    page_count smallint DEFAULT 0 NOT NULL,
    processing_attempts smallint DEFAULT 0 NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    uploads_closed_at timestamp with time zone,
    CONSTRAINT assignments_created_by_kind_check CHECK ((created_by_kind = ANY (ARRAY['parent'::text, 'child'::text]))),
    CONSTRAINT assignments_idempotency_key_check CHECK (((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT assignments_page_count_check CHECK (((page_count >= 0) AND (page_count <= 50))),
    CONSTRAINT assignments_processing_attempts_check CHECK ((processing_attempts >= 0)),
    CONSTRAINT assignments_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'uploading'::text, 'queued'::text, 'extracting'::text, 'checking'::text, 'verifying'::text, 'ready'::text, 'needs_rescan'::text, 'needs_parent_review'::text, 'failed_retryable'::text, 'failed_final'::text, 'cancelled'::text, 'deleted'::text])))
);


--
-- Name: attempt_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attempt_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_id uuid NOT NULL,
    family_id uuid NOT NULL,
    correctness text NOT NULL,
    reason text NOT NULL,
    overridden_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attempt_overrides_correctness_check CHECK ((correctness = ANY (ARRAY['correct'::text, 'incorrect'::text, 'unresolved'::text]))),
    CONSTRAINT attempt_overrides_reason_check CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 300)))
);


--
-- Name: attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    question_instance_id uuid NOT NULL,
    source text NOT NULL,
    subject_key text NOT NULL,
    skill text NOT NULL,
    attempt_number smallint NOT NULL,
    hints_used smallint DEFAULT 0 NOT NULL,
    correctness text NOT NULL,
    independent boolean GENERATED ALWAYS AS (((attempt_number = 1) AND (hints_used = 0))) STORED,
    grader_version text NOT NULL,
    idempotency_key text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence_key text,
    meaningful boolean,
    CONSTRAINT attempts_attempt_number_check CHECK ((attempt_number >= 1)),
    CONSTRAINT attempts_correctness_check CHECK ((correctness = ANY (ARRAY['correct'::text, 'incorrect'::text, 'unresolved'::text]))),
    CONSTRAINT attempts_evidence_key_check CHECK (((evidence_key IS NULL) OR (evidence_key ~ '^bank:[0-9a-f]{64}$'::text))),
    CONSTRAINT attempts_hints_used_check CHECK ((hints_used >= 0)),
    CONSTRAINT attempts_idempotency_key_check CHECK (((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT attempts_source_check CHECK ((source = ANY (ARRAY['homework'::text, 'daily'::text, 'review'::text])))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id bigint NOT NULL,
    family_id uuid,
    actor_user_id uuid,
    actor_kind text NOT NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_events_action_check CHECK (((char_length(action) >= 1) AND (char_length(action) <= 100))),
    CONSTRAINT audit_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['parent'::text, 'child'::text, 'admin'::text, 'system'::text, 'provider'::text]))),
    CONSTRAINT audit_events_metadata_json_shape CHECK (((metadata IS NULL) OR (jsonb_typeof(metadata) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    channel text NOT NULL,
    provider_period_id text NOT NULL,
    kind text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    paid_slots smallint NOT NULL,
    regular_amount_cents integer NOT NULL,
    charged_amount_cents integer NOT NULL,
    discount_cents integer DEFAULT 0 NOT NULL,
    discount_sources text[] DEFAULT '{}'::text[] NOT NULL,
    settlement text NOT NULL,
    settled_at timestamp with time zone,
    refunded_cents integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_amount_cents integer DEFAULT 0 NOT NULL,
    chargeback_cents integer DEFAULT 0 NOT NULL,
    CONSTRAINT billing_periods_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT billing_periods_chargeback_cents_non_negative CHECK ((chargeback_cents >= 0)),
    CONSTRAINT billing_periods_chargeback_cents_within_refund CHECK ((chargeback_cents <= refunded_cents)),
    CONSTRAINT billing_periods_charged_amount_cents_check CHECK ((charged_amount_cents >= 0)),
    CONSTRAINT billing_periods_check CHECK ((period_end > period_start)),
    CONSTRAINT billing_periods_check1 CHECK (((settlement <> 'settled'::text) OR (settled_at IS NOT NULL))),
    CONSTRAINT billing_periods_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT billing_periods_discount_cents_check CHECK ((discount_cents >= 0)),
    CONSTRAINT billing_periods_discount_sources_check CHECK ((discount_sources <@ ARRAY['promo_code'::text, 'promotional_credit'::text, 'introductory_offer'::text, 'other_discount'::text])),
    CONSTRAINT billing_periods_kind_check CHECK ((kind = ANY (ARRAY['subscription_period'::text, 'proration'::text, 'addon'::text, 'tax_only'::text]))),
    CONSTRAINT billing_periods_paid_slots_check CHECK (((paid_slots >= 1) AND (paid_slots <= 12))),
    CONSTRAINT billing_periods_provider_period_id_check CHECK (((char_length(provider_period_id) >= 1) AND (char_length(provider_period_id) <= 200))),
    CONSTRAINT billing_periods_refunded_cents_check CHECK ((refunded_cents >= 0)),
    CONSTRAINT billing_periods_regular_amount_cents_check CHECK ((regular_amount_cents >= 0)),
    CONSTRAINT billing_periods_settlement_check CHECK ((settlement = ANY (ARRAY['pending'::text, 'settled'::text, 'failed'::text, 'refunded'::text, 'partially_refunded'::text, 'chargeback'::text]))),
    CONSTRAINT billing_periods_tax_amount_cents_non_negative CHECK ((tax_amount_cents >= 0))
);


--
-- Name: COLUMN billing_periods.tax_amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.billing_periods.tax_amount_cents IS 'The share of the invoice''s sales tax that belongs to THIS period''s charge, in integer cents (HUNT5-C-2 / N1-TAX-APPORTION) — not the invoice''s whole tax, which on a renewal carrying a proration line also covers that line. Both periods one invoice can write carry their own share: the subscription charge''s, and (HUNT7-C-4) the ''<invoice>:proration'' row''s, because the figure that reaches that row is the leftover of the provider''s tax-INCLUSIVE amount and it has to be restated in the row''s own pre-tax unit like any other. Each share is FLOORED, so no row ever stores more tax than was levied on it and the conversion can only over-record a refund, never under-record one. NEVER revenue: it is stored only so a provider refund amount, which includes tax, can be stated in the same unit as charged_amount_cents by the ratio charged_amount_cents / (charged_amount_cents + tax_amount_cents). 0 for a channel that reports no tax, for an untaxed invoice, and for every period recorded before migration 0900 — the ratio is then 1 and the conversion a no-op.';


--
-- Name: COLUMN billing_periods.chargeback_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.billing_periods.chargeback_cents IS 'How much of refunded_cents an OPEN provider dispute contributed, in integer cents and in charged_amount_cents'' pre-tax unit (HUNT7-C-2). NEVER revenue and never a second refund figure: refunded_cents is the whole amount clawed back and this is the part of it a chargeback added, so refunded_cents - chargeback_cents is what the family was genuinely refunded. A won dispute (chargeback_reversed) gives back exactly this and sets it to 0, which is what keeps an earlier partial refund on the record when the cap clipped the addition. 0 for every row written before migration 0950 and for every period no dispute has touched.';


--
-- Name: billing_provider_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_provider_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    family_id uuid,
    event_type text NOT NULL,
    payload_sha256 text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    status text DEFAULT 'received'::text NOT NULL,
    error_code text,
    CONSTRAINT billing_provider_events_payload_sha256_check CHECK ((payload_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT billing_provider_events_provider_check CHECK ((provider = ANY (ARRAY['revenuecat'::text, 'stripe'::text]))),
    CONSTRAINT billing_provider_events_provider_event_id_check CHECK (((char_length(provider_event_id) >= 1) AND (char_length(provider_event_id) <= 200))),
    CONSTRAINT billing_provider_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'ignored'::text, 'failed'::text])))
);


--
-- Name: capacity_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capacity_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    kind text NOT NULL,
    from_slots smallint NOT NULL,
    to_slots smallint NOT NULL,
    keep_child_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    status text DEFAULT 'pending_purchase'::text NOT NULL,
    provider_effective_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capacity_changes_check CHECK ((from_slots <> to_slots)),
    CONSTRAINT capacity_changes_from_slots_check CHECK (((from_slots >= 0) AND (from_slots <= 12))),
    CONSTRAINT capacity_changes_kind_check CHECK ((kind = ANY (ARRAY['upgrade'::text, 'downgrade'::text]))),
    CONSTRAINT capacity_changes_status_check CHECK ((status = ANY (ARRAY['pending_purchase'::text, 'scheduled'::text, 'applied'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT capacity_changes_to_slots_check CHECK (((to_slots >= 0) AND (to_slots <= 12)))
);


--
-- Name: child_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    label text NOT NULL,
    platform text NOT NULL,
    paired_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT child_devices_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60))),
    CONSTRAINT child_devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


--
-- Name: child_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    guard_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT child_feedback_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000))),
    CONSTRAINT child_feedback_kind_check CHECK ((kind = ANY (ARRAY['hint'::text, 'method_step'::text, 'analogous_example'::text, 'encouragement'::text, 'template_fallback'::text, 'safety'::text])))
);


--
-- Name: child_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    nickname text NOT NULL,
    grade_level smallint NOT NULL,
    age_band text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    accessibility jsonb DEFAULT '{}'::jsonb NOT NULL,
    curriculum_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    attestation_version text,
    attested_at timestamp with time zone,
    attested_by uuid,
    CONSTRAINT child_profiles_accessibility_json_shape CHECK (((accessibility IS NULL) OR (jsonb_typeof(accessibility) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT child_profiles_active_requires_attestation CHECK (((status <> 'active'::text) OR (attested_at IS NOT NULL))),
    CONSTRAINT child_profiles_age_band_check CHECK ((age_band = ANY (ARRAY['5-7'::text, '8-10'::text, '11-13'::text, '14-18'::text]))),
    CONSTRAINT child_profiles_attestation_complete CHECK ((((attestation_version IS NULL) AND (attested_at IS NULL) AND (attested_by IS NULL)) OR ((attestation_version IS NOT NULL) AND (attested_at IS NOT NULL) AND (attested_by IS NOT NULL)))),
    CONSTRAINT child_profiles_curriculum_notes_check CHECK ((char_length(curriculum_notes) <= 2000)),
    CONSTRAINT child_profiles_grade_level_check CHECK (((grade_level >= 0) AND (grade_level <= 12))),
    CONSTRAINT child_profiles_nickname_check CHECK (((char_length(nickname) >= 1) AND (char_length(nickname) <= 40))),
    CONSTRAINT child_profiles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])))
);


--
-- Name: COLUMN child_profiles.attestation_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.child_profiles.attestation_version IS 'Version of the parental/guardian statement the adult agreed to (contracts CONSENT_ATTESTATION_VERSION). The wording itself is versioned in the repository, so the version plus the instant reconstructs exactly what was agreed.';


--
-- Name: COLUMN child_profiles.attested_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.child_profiles.attested_at IS 'When the adult made the attestation for THIS child. Never a default: it is the instant the request carried.';


--
-- Name: COLUMN child_profiles.attested_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.child_profiles.attested_by IS 'The adult who attested. Several guardians can share a family, so which one made the claim is part of the record.';


--
-- Name: child_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    device_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text
);


--
-- Name: child_slot_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_slot_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    release_reason text,
    CONSTRAINT child_slot_assignments_check CHECK (((released_at IS NULL) = (release_reason IS NULL))),
    CONSTRAINT child_slot_assignments_release_reason_check CHECK ((release_reason = ANY (ARRAY['downgrade'::text, 'archived'::text, 'expired'::text, 'reassigned'::text])))
);


--
-- Name: child_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.child_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    subject_key text NOT NULL,
    display_name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT child_subjects_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 60))),
    CONSTRAINT child_subjects_subject_key_check CHECK ((subject_key = ANY (ARRAY['math'::text, 'reading'::text, 'spelling_vocabulary'::text, 'grammar_writing'::text, 'science'::text, 'social_studies'::text, 'custom'::text])))
);


--
-- Name: consent_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    adult_user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_reference text,
    method text NOT NULL,
    purpose text NOT NULL,
    policy_version text NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    is_test_provider boolean NOT NULL,
    verified_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consent_records_check CHECK (((status <> 'verified'::text) OR (verified_at IS NOT NULL))),
    CONSTRAINT consent_records_check1 CHECK (((status <> 'withdrawn'::text) OR (withdrawn_at IS NOT NULL))),
    CONSTRAINT consent_records_scope_json_shape CHECK (((scope IS NULL) OR (jsonb_typeof(scope) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT consent_records_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'failed'::text, 'withdrawn'::text])))
);


--
-- Name: data_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    kind text NOT NULL,
    child_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    storage_path text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_exports_kind_check CHECK ((kind = ANY (ARRAY['family_data'::text, 'progress_pdf'::text, 'progress_csv'::text, 'review_questions_pdf'::text, 'review_answer_key_pdf'::text]))),
    CONSTRAINT data_exports_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'ready'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: donation_accruals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.donation_accruals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    school_id uuid NOT NULL,
    donation_month text NOT NULL,
    amount_cents integer DEFAULT 100 NOT NULL,
    billing_period_id uuid NOT NULL,
    eligibility_snapshot jsonb NOT NULL,
    payout_batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT donation_accruals_amount_cents_check CHECK ((amount_cents = 100)),
    CONSTRAINT donation_accruals_donation_month_check CHECK ((donation_month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT donation_accruals_eligibility_snapshot_json_shape CHECK (((eligibility_snapshot IS NULL) OR (jsonb_typeof(eligibility_snapshot) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: donation_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.donation_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    accrual_id uuid NOT NULL,
    amount_cents integer NOT NULL,
    reason text NOT NULL,
    idempotency_key text NOT NULL,
    payout_batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT donation_adjustments_amount_cents_check CHECK ((amount_cents = ANY (ARRAY['-100'::integer, 100]))),
    CONSTRAINT donation_adjustments_reason_check CHECK ((reason = ANY (ARRAY['refund'::text, 'partial_refund'::text, 'chargeback'::text, 'chargeback_reversed'::text])))
);


--
-- Name: donation_payout_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.donation_payout_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    batch_key text NOT NULL,
    total_cents integer NOT NULL,
    status text DEFAULT 'accrued'::text NOT NULL,
    external_transfer_ref text,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    paid_at timestamp with time zone,
    CONSTRAINT donation_payout_batches_batch_key_check CHECK (((char_length(batch_key) >= 8) AND (char_length(batch_key) <= 200))),
    CONSTRAINT donation_payout_batches_check CHECK (((status <> 'paid'::text) OR ((external_transfer_ref IS NOT NULL) AND (paid_at IS NOT NULL)))),
    CONSTRAINT donation_payout_batches_status_check CHECK ((status = ANY (ARRAY['accrued'::text, 'approved'::text, 'paid'::text, 'failed'::text, 'adjusted'::text]))),
    CONSTRAINT donation_payout_batches_total_cents_check CHECK ((total_cents > 0))
);


--
-- Name: extracted_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extracted_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    page_id uuid NOT NULL,
    question_number text NOT NULL,
    bounding_box jsonb,
    prompt_text text NOT NULL,
    student_answer_text text,
    answer_kind text NOT NULL,
    subject_key text NOT NULL,
    skill text NOT NULL,
    subskill text,
    grade_estimate smallint,
    uncertainty text,
    transcription_version integer DEFAULT 1 NOT NULL,
    corrected_prompt_text text,
    corrected_student_answer_text text,
    corrected_by uuid,
    corrected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extracted_questions_answer_kind_check CHECK ((answer_kind = ANY (ARRAY['numeric'::text, 'quantity'::text, 'division_remainder'::text, 'multiple_choice'::text, 'spelling'::text, 'exact_text'::text, 'open_response'::text, 'writing'::text]))),
    CONSTRAINT extracted_questions_bounding_box_json_shape CHECK (((bounding_box IS NULL) OR (jsonb_typeof(bounding_box) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT extracted_questions_grade_estimate_check CHECK (((grade_estimate >= 0) AND (grade_estimate <= 12))),
    CONSTRAINT extracted_questions_prompt_text_check CHECK ((char_length(prompt_text) <= 4000)),
    CONSTRAINT extracted_questions_question_number_check CHECK (((char_length(question_number) >= 1) AND (char_length(question_number) <= 20))),
    CONSTRAINT extracted_questions_skill_check CHECK (((char_length(skill) >= 1) AND (char_length(skill) <= 120))),
    CONSTRAINT extracted_questions_student_answer_text_check CHECK ((char_length(student_answer_text) <= 4000)),
    CONSTRAINT extracted_questions_uncertainty_check CHECK ((uncertainty = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))
);


--
-- Name: families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.families (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    billing_ref text DEFAULT ('fam_'::text || encode(public.gen_random_bytes(12), 'hex'::text)) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deletion_requested_at timestamp with time zone,
    deleted_at timestamp with time zone,
    inactivity_notified_at timestamp with time zone,
    CONSTRAINT families_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 80))),
    CONSTRAINT families_timezone_check CHECK (((char_length(timezone) >= 1) AND (char_length(timezone) <= 64)))
);


--
-- Name: family_capacity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_capacity (
    family_id uuid NOT NULL,
    paid_slots smallint DEFAULT 0 NOT NULL,
    managing_channel text,
    conflict text,
    pending_target_slots smallint,
    pending_effective_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_capacity_conflict_check CHECK ((conflict = 'duplicate_active_subscriptions'::text)),
    CONSTRAINT family_capacity_managing_channel_check CHECK ((managing_channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT family_capacity_paid_slots_check CHECK (((paid_slots >= 0) AND (paid_slots <= 12))),
    CONSTRAINT family_capacity_pending_target_slots_check CHECK (((pending_target_slots >= 0) AND (pending_target_slots <= 12)))
);


--
-- Name: family_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_entitlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    channel text NOT NULL,
    provider_subscription_id text NOT NULL,
    product_id text NOT NULL,
    paid_slots smallint NOT NULL,
    status text NOT NULL,
    environment text NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    auto_renew boolean DEFAULT true NOT NULL,
    pending_product_id text,
    pending_effective_at timestamp with time zone,
    provider_updated_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_entitlements_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT family_entitlements_check CHECK (((period_end IS NULL) OR (period_start IS NULL) OR (period_end > period_start))),
    CONSTRAINT family_entitlements_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT family_entitlements_paid_slots_check CHECK (((paid_slots >= 0) AND (paid_slots <= 12))),
    CONSTRAINT family_entitlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'grace_period'::text, 'billing_retry'::text, 'cancelled_active'::text, 'expired'::text, 'revoked'::text, 'refunded'::text])))
);


--
-- Name: family_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    invited_by uuid,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT family_memberships_check CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT family_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'guardian'::text]))),
    CONSTRAINT family_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);


--
-- Name: family_monetization_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_monetization_prefs (
    family_id uuid NOT NULL,
    hide_affiliate boolean DEFAULT false NOT NULL,
    hide_sponsor_cards boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: family_school_attributions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_school_attributions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    school_id uuid NOT NULL,
    source text NOT NULL,
    attributed_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT family_school_attributions_source_check CHECK ((source = ANY (ARRAY['school_code'::text, 'promo'::text, 'manual'::text])))
);


--
-- Name: family_school_designations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_school_designations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    school_id uuid NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_school_designations_check CHECK (((effective_to IS NULL) OR (effective_to > effective_from))),
    CONSTRAINT family_school_designations_effective_from_check CHECK ((EXTRACT(day FROM effective_from) = (1)::numeric)),
    CONSTRAINT family_school_designations_effective_to_check CHECK (((effective_to IS NULL) OR (EXTRACT(day FROM effective_to) = (1)::numeric)))
);


--
-- Name: guardian_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guardian_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    email public.citext NOT NULL,
    invited_by uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guardian_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    family_id uuid,
    child_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    max_attempts smallint DEFAULT 5 NOT NULL,
    run_after timestamp with time zone DEFAULT app.request_instant() NOT NULL,
    locked_until timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT jobs_check CHECK ((attempts <= max_attempts)),
    CONSTRAINT jobs_idempotency_key_check CHECK (((char_length(idempotency_key) >= 3) AND (char_length(idempotency_key) <= 300))),
    CONSTRAINT jobs_kind_check CHECK ((kind = ANY (ARRAY['scan_process'::text, 'daily_set_generate'::text, 'thursday_review_generate'::text, 'review_top_up'::text, 'promo_month_generate'::text, 'promo_offer_provision'::text, 'promo_reconcile'::text, 'donation_accrue'::text, 'payout_prepare'::text, 'entitlement_reconcile'::text, 'retention_purge'::text, 'deletion_purge'::text, 'notification_send'::text, 'export_build'::text, 'safety_flag_email'::text, 'account_close'::text]))),
    CONSTRAINT jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 20))),
    CONSTRAINT jobs_payload_json_shape CHECK (((payload IS NULL) OR (jsonb_typeof(payload) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed_retryable'::text, 'failed_final'::text, 'cancelled'::text, 'dead_letter'::text])))
);


--
-- Name: learning_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_schedules (
    child_id uuid NOT NULL,
    family_id uuid NOT NULL,
    review_weekday smallint DEFAULT 4 NOT NULL,
    review_local_time time without time zone DEFAULT '16:00:00'::time without time zone NOT NULL,
    review_questions_per_subject smallint DEFAULT 8 NOT NULL,
    schedule_version integer DEFAULT 1 NOT NULL,
    daily_local_time time without time zone DEFAULT '15:30:00'::time without time zone NOT NULL,
    daily_question_count smallint DEFAULT 5 NOT NULL,
    paused_from date,
    paused_to date,
    quiet_hours_start time without time zone,
    quiet_hours_end time without time zone,
    child_reminders_permitted boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_schedules_check CHECK (((paused_from IS NULL) = (paused_to IS NULL))),
    CONSTRAINT learning_schedules_check1 CHECK (((paused_to IS NULL) OR (paused_to >= paused_from))),
    CONSTRAINT learning_schedules_daily_question_count_check CHECK (((daily_question_count >= 3) AND (daily_question_count <= 10))),
    CONSTRAINT learning_schedules_review_questions_per_subject_check CHECK (((review_questions_per_subject >= 4) AND (review_questions_per_subject <= 20))),
    CONSTRAINT learning_schedules_review_weekday_check CHECK (((review_weekday >= 1) AND (review_weekday <= 7))),
    CONSTRAINT learning_schedules_schedule_version_check CHECK ((schedule_version >= 1))
);


--
-- Name: monetization_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monetization_switches (
    key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text,
    CONSTRAINT monetization_switches_key_check CHECK ((key = ANY (ARRAY['global'::text, 'provider:sponsor_direct'::text, 'provider:amazon_associates'::text, 'provider:ad_network'::text]))),
    CONSTRAINT monetization_switches_reason_check CHECK ((char_length(reason) <= 300))
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    device_id uuid NOT NULL,
    message_key text NOT NULL,
    dedupe_key text NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_deliveries_message_key_check CHECK ((message_key = ANY (ARRAY['review_ready'::text, 'daily_ready'::text, 'scan_ready'::text, 'needs_parent_review'::text, 'reward_requested'::text, 'billing_attention'::text, 'promo_confirmed'::text]))),
    CONSTRAINT notification_deliveries_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'failed'::text, 'suppressed_quiet_hours'::text, 'suppressed_opt_out'::text, 'suppressed_permission'::text])))
);


--
-- Name: notification_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    owner_kind text NOT NULL,
    user_id uuid,
    child_id uuid,
    platform text NOT NULL,
    opted_in boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT notification_devices_check CHECK (((owner_kind = 'parent'::text) = (user_id IS NOT NULL))),
    CONSTRAINT notification_devices_check1 CHECK (((owner_kind = 'child'::text) = (child_id IS NOT NULL))),
    CONSTRAINT notification_devices_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['parent'::text, 'child'::text]))),
    CONSTRAINT notification_devices_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))
);


--
-- Name: ops_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT ops_settings_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT ops_settings_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);


--
-- Name: pending_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_refunds (
    family_id uuid NOT NULL,
    channel text NOT NULL,
    provider_period_id text NOT NULL,
    kind text NOT NULL,
    refunded_cents integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pending_refunds_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT pending_refunds_kind_check CHECK ((kind = ANY (ARRAY['refund'::text, 'partial_refund'::text, 'chargeback'::text]))),
    CONSTRAINT pending_refunds_provider_period_id_check CHECK (((char_length(provider_period_id) >= 1) AND (char_length(provider_period_id) <= 200))),
    CONSTRAINT pending_refunds_refunded_cents_check CHECK ((refunded_cents >= 0))
);


--
-- Name: placement_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.placement_rules (
    placement text NOT NULL,
    max_cards_per_screen smallint DEFAULT 1 NOT NULL,
    max_new_cards_per_session smallint DEFAULT 3 NOT NULL,
    min_visible_ms integer DEFAULT 1000 NOT NULL,
    min_visible_ratio numeric(3,2) DEFAULT 0.50 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT placement_rules_max_cards_per_screen_check CHECK ((max_cards_per_screen = 1)),
    CONSTRAINT placement_rules_max_new_cards_per_session_check CHECK (((max_new_cards_per_session >= 0) AND (max_new_cards_per_session <= 3))),
    CONSTRAINT placement_rules_min_visible_ms_check CHECK (((min_visible_ms >= 1000) AND (min_visible_ms <= 60000))),
    CONSTRAINT placement_rules_min_visible_ratio_check CHECK (((min_visible_ratio >= 0.50) AND (min_visible_ratio <= 1.00))),
    CONSTRAINT placement_rules_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text])))
);


--
-- Name: point_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_balances (
    child_id uuid NOT NULL,
    family_id uuid NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT point_balances_balance_check CHECK ((balance >= 0))
);


--
-- Name: points_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_ledger (
    id bigint NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    kind text NOT NULL,
    points integer NOT NULL,
    idempotency_key text NOT NULL,
    reason text,
    redemption_id uuid,
    actor_kind text NOT NULL,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT points_ledger_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['system'::text, 'parent'::text, 'child'::text]))),
    CONSTRAINT points_ledger_check CHECK (((kind <> 'adjustment'::text) OR ((reason IS NOT NULL) AND (char_length(btrim(reason)) > 0)))),
    CONSTRAINT points_ledger_check1 CHECK (((kind <> ALL (ARRAY['redemption_reserve'::text, 'redemption_release'::text])) OR (redemption_id IS NOT NULL))),
    CONSTRAINT points_ledger_check2 CHECK (((kind <> 'redemption_reserve'::text) OR (points < 0))),
    CONSTRAINT points_ledger_check3 CHECK (((kind <> 'redemption_release'::text) OR (points > 0))),
    CONSTRAINT points_ledger_idempotency_key_check CHECK (((char_length(idempotency_key) >= 3) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT points_ledger_kind_check CHECK ((kind = ANY (ARRAY['award'::text, 'adjustment'::text, 'redemption_reserve'::text, 'redemption_release'::text]))),
    CONSTRAINT points_ledger_points_check CHECK ((points <> 0)),
    CONSTRAINT points_ledger_reason_check CHECK ((char_length(reason) <= 300))
);


--
-- Name: points_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.points_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.points_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: practice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.practice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    set_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    "position" smallint NOT NULL,
    subject_key text NOT NULL,
    skill text NOT NULL,
    category text NOT NULL,
    template_id uuid,
    prompt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT practice_items_category_check CHECK ((category = ANY (ARRAY['weak'::text, 'spaced'::text, 'confidence'::text, 'cumulative'::text, 'fallback'::text, 'prerequisite'::text]))),
    CONSTRAINT practice_items_position_check CHECK ((("position" >= 1) AND ("position" <= 200))),
    CONSTRAINT practice_items_prompt_json_shape CHECK (((prompt IS NULL) OR (jsonb_typeof(prompt) = ANY (ARRAY['object'::text, 'array'::text]))))
);


--
-- Name: practice_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.practice_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    kind text NOT NULL,
    set_key text NOT NULL,
    subject_key text,
    local_date date,
    review_week text,
    version smallint DEFAULT 1 NOT NULL,
    status text DEFAULT 'generating'::text NOT NULL,
    mix jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    ready_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    release_at timestamp with time zone,
    evidence_cutoff_at timestamp with time zone,
    child_intro text,
    CONSTRAINT practice_sets_child_intro_check CHECK (((child_intro IS NULL) OR ((char_length(child_intro) >= 1) AND (char_length(child_intro) <= 200)))),
    CONSTRAINT practice_sets_kind_check CHECK ((kind = ANY (ARRAY['daily'::text, 'thursday_review'::text, 'top_up'::text]))),
    CONSTRAINT practice_sets_mix_json_shape CHECK (((mix IS NULL) OR (jsonb_typeof(mix) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT practice_sets_notes_json_shape CHECK (((notes IS NULL) OR (jsonb_typeof(notes) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT practice_sets_review_week_check CHECK ((review_week ~ '^\d{4}-W\d{2}$'::text)),
    CONSTRAINT practice_sets_status_check CHECK ((status = ANY (ARRAY['generating'::text, 'ready'::text, 'in_progress'::text, 'completed'::text, 'expired'::text, 'failed'::text]))),
    CONSTRAINT practice_sets_version_check CHECK ((version >= 1))
);


--
-- Name: promo_benefit_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_benefit_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    redemption_id uuid NOT NULL,
    family_id uuid NOT NULL,
    channel text NOT NULL,
    provider_period_id text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_benefit_periods_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT promo_benefit_periods_check CHECK ((period_end > period_start))
);


--
-- Name: promo_campaign_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_campaign_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    school_id uuid,
    percent_off smallint NOT NULL,
    eligible_tiers smallint[] NOT NULL,
    subscriber_eligibility text[] NOT NULL,
    redemption_cap integer NOT NULL,
    budget_cap_cents integer NOT NULL,
    calendar_timezone text DEFAULT 'UTC'::text NOT NULL,
    timezone_confirmed boolean DEFAULT false NOT NULL,
    window_start_day smallint DEFAULT 1 NOT NULL,
    window_end_day smallint DEFAULT 0 NOT NULL,
    code_mode text NOT NULL,
    individual_code_count integer,
    shared_code_usage_cap integer,
    channels text[] NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_campaign_templates_budget_cap_cents_check CHECK ((budget_cap_cents > 0)),
    CONSTRAINT promo_campaign_templates_channels_check CHECK (((cardinality(channels) > 0) AND (channels <@ ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT promo_campaign_templates_check CHECK (((code_mode <> 'individual'::text) OR (individual_code_count IS NOT NULL))),
    CONSTRAINT promo_campaign_templates_check1 CHECK (((NOT enabled) OR timezone_confirmed)),
    CONSTRAINT promo_campaign_templates_code_mode_check CHECK ((code_mode = ANY (ARRAY['shared'::text, 'individual'::text]))),
    CONSTRAINT promo_campaign_templates_eligible_tiers_check CHECK (((cardinality(eligible_tiers) > 0) AND (eligible_tiers <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint, (7)::smallint, (8)::smallint, (9)::smallint, (10)::smallint, (11)::smallint, (12)::smallint]))),
    CONSTRAINT promo_campaign_templates_individual_code_count_check CHECK ((individual_code_count > 0)),
    CONSTRAINT promo_campaign_templates_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT promo_campaign_templates_percent_off_check CHECK (((percent_off >= 5) AND (percent_off <= 100))),
    CONSTRAINT promo_campaign_templates_redemption_cap_check CHECK ((redemption_cap > 0)),
    CONSTRAINT promo_campaign_templates_shared_code_usage_cap_check CHECK ((shared_code_usage_cap > 0)),
    CONSTRAINT promo_campaign_templates_subscriber_eligibility_check CHECK (((cardinality(subscriber_eligibility) > 0) AND (subscriber_eligibility <@ ARRAY['new'::text, 'existing'::text, 'lapsed'::text]))),
    CONSTRAINT promo_campaign_templates_window_end_day_check CHECK (((window_end_day >= 0) AND (window_end_day <= 31))),
    CONSTRAINT promo_campaign_templates_window_start_day_check CHECK (((window_start_day >= 1) AND (window_start_day <= 28)))
);


--
-- Name: promo_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    campaign_month text NOT NULL,
    generation_key text NOT NULL,
    school_id uuid,
    percent_off smallint NOT NULL,
    eligible_tiers smallint[] NOT NULL,
    subscriber_eligibility text[] NOT NULL,
    redemption_cap integer NOT NULL,
    budget_cap_cents integer NOT NULL,
    opens_at timestamp with time zone NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    status text DEFAULT 'provisioning'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_campaigns_budget_cap_cents_check CHECK ((budget_cap_cents > 0)),
    CONSTRAINT promo_campaigns_campaign_month_check CHECK ((campaign_month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT promo_campaigns_check CHECK ((generation_key = (((template_id)::text || ':'::text) || campaign_month))),
    CONSTRAINT promo_campaigns_check1 CHECK ((closes_at > opens_at)),
    CONSTRAINT promo_campaigns_percent_off_check CHECK (((percent_off >= 5) AND (percent_off <= 100))),
    CONSTRAINT promo_campaigns_redemption_cap_check CHECK ((redemption_cap > 0)),
    CONSTRAINT promo_campaigns_status_check CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'paused'::text, 'revoked'::text, 'ended'::text, 'failed'::text])))
);


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    code_normalized text NOT NULL,
    usage_cap integer,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_codes_code_normalized_check CHECK ((code_normalized ~ '^[0-9A-HJKMNP-TV-Z]{10}[0-9A-HJKMNP-TV-Z*~$=U]$'::text)),
    CONSTRAINT promo_codes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT promo_codes_usage_cap_check CHECK ((usage_cap > 0))
);


--
-- Name: promo_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    code_id uuid NOT NULL,
    channel text NOT NULL,
    target_period_key text NOT NULL,
    target_period_start timestamp with time zone,
    state text DEFAULT 'reserved'::text NOT NULL,
    idempotency_key text NOT NULL,
    paid_slots smallint NOT NULL,
    percent_off smallint NOT NULL,
    regular_cents integer NOT NULL,
    discount_cents integer NOT NULL,
    charged_cents integer NOT NULL,
    provider_reference text,
    redeemed_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone,
    CONSTRAINT promo_redemptions_channel_check CHECK ((channel = ANY (ARRAY['app_store'::text, 'play_store'::text, 'stripe'::text, 'amazon_appstore'::text]))),
    CONSTRAINT promo_redemptions_charged_cents_check CHECK ((charged_cents >= 0)),
    CONSTRAINT promo_redemptions_check CHECK (((discount_cents + charged_cents) = regular_cents)),
    CONSTRAINT promo_redemptions_check1 CHECK (((state <> ALL (ARRAY['confirmed'::text, 'reconciled'::text])) OR (confirmed_at IS NOT NULL))),
    CONSTRAINT promo_redemptions_discount_cents_check CHECK ((discount_cents >= 0)),
    CONSTRAINT promo_redemptions_idempotency_key_check CHECK (((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT promo_redemptions_paid_slots_check CHECK (((paid_slots >= 1) AND (paid_slots <= 12))),
    CONSTRAINT promo_redemptions_percent_off_check CHECK (((percent_off >= 5) AND (percent_off <= 100))),
    CONSTRAINT promo_redemptions_regular_cents_check CHECK ((regular_cents > 0)),
    CONSTRAINT promo_redemptions_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'provider_pending'::text, 'confirmed'::text, 'rejected'::text, 'expired'::text, 'reconciled'::text]))),
    CONSTRAINT promo_redemptions_target_period_key_check CHECK (((char_length(target_period_key) >= 1) AND (char_length(target_period_key) <= 80)))
);


--
-- Name: question_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.question_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_key text NOT NULL,
    subject_key text NOT NULL,
    skill text NOT NULL,
    grade_min smallint NOT NULL,
    grade_max smallint NOT NULL,
    prompt_template jsonb NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text NOT NULL,
    license_note text,
    review_status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT question_templates_check CHECK (((grade_max >= grade_min) AND (grade_max <= 12))),
    CONSTRAINT question_templates_grade_min_check CHECK (((grade_min >= 0) AND (grade_min <= 12))),
    CONSTRAINT question_templates_parameters_json_shape CHECK (((parameters IS NULL) OR (jsonb_typeof(parameters) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT question_templates_prompt_template_json_shape CHECK (((prompt_template IS NULL) OR (jsonb_typeof(prompt_template) = ANY (ARRAY['object'::text, 'array'::text])))),
    CONSTRAINT question_templates_review_status_check CHECK ((review_status = ANY (ARRAY['draft'::text, 'reviewed'::text, 'retired'::text]))),
    CONSTRAINT question_templates_source_check CHECK ((source = ANY (ARRAY['original'::text, 'licensed'::text]))),
    CONSTRAINT question_templates_subject_key_check CHECK ((subject_key = ANY (ARRAY['math'::text, 'reading'::text, 'spelling_vocabulary'::text, 'grammar_writing'::text, 'science'::text, 'social_studies'::text])))
);


--
-- Name: revenue_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid NOT NULL,
    kind text NOT NULL,
    amount_cents integer NOT NULL,
    reason text NOT NULL,
    idempotency_key text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revenue_adjustments_amount_cents_check CHECK (((amount_cents <> 0) AND ((amount_cents >= '-2000000000'::integer) AND (amount_cents <= 2000000000)))),
    CONSTRAINT revenue_adjustments_check CHECK (((kind = 'correction'::text) OR (amount_cents < 0))),
    CONSTRAINT revenue_adjustments_idempotency_key_check CHECK (((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT revenue_adjustments_kind_check CHECK ((kind = ANY (ARRAY['refund'::text, 'reversal'::text, 'correction'::text]))),
    CONSTRAINT revenue_adjustments_reason_check CHECK (((char_length(btrim(reason)) >= 3) AND (char_length(btrim(reason)) <= 300)))
);


--
-- Name: revenue_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_id uuid NOT NULL,
    source text NOT NULL,
    external_ref text NOT NULL,
    category text NOT NULL,
    provider text NOT NULL,
    campaign_id uuid,
    placement text,
    amount_cents integer NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    period_month text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revenue_entries_amount_cents_check CHECK (((amount_cents >= 0) AND (amount_cents <= 2000000000))),
    CONSTRAINT revenue_entries_category_check CHECK ((category = ANY (ARRAY['projected'::text, 'contracted'::text, 'recognized'::text, 'received'::text, 'affiliate_reported'::text]))),
    CONSTRAINT revenue_entries_check CHECK (((provider = 'amazon_associates'::text) OR (placement IS NOT NULL))),
    CONSTRAINT revenue_entries_check1 CHECK (((campaign_id IS NULL) OR (provider = 'sponsor_direct'::text))),
    CONSTRAINT revenue_entries_currency_check CHECK ((currency = 'USD'::text)),
    CONSTRAINT revenue_entries_external_ref_check CHECK (((char_length(btrim(external_ref)) >= 1) AND (char_length(btrim(external_ref)) <= 200))),
    CONSTRAINT revenue_entries_period_month_check CHECK ((period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT revenue_entries_placement_check CHECK ((placement = ANY (ARRAY['adult_dashboard'::text, 'resources_browse'::text]))),
    CONSTRAINT revenue_entries_provider_check CHECK ((provider = ANY (ARRAY['sponsor_direct'::text, 'amazon_associates'::text, 'ad_network'::text])))
);


--
-- Name: revenue_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    file_sha256 text NOT NULL,
    period_month text NOT NULL,
    imported_by uuid NOT NULL,
    row_count integer NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revenue_imports_file_sha256_check CHECK ((file_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT revenue_imports_note_check CHECK ((char_length(note) <= 300)),
    CONSTRAINT revenue_imports_period_month_check CHECK ((period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT revenue_imports_row_count_check CHECK ((row_count >= 0)),
    CONSTRAINT revenue_imports_source_check CHECK ((source = ANY (ARRAY['sponsor_invoice'::text, 'amazon_report'::text, 'ad_network'::text, 'manual'::text])))
);


--
-- Name: reward_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_rules (
    family_id uuid NOT NULL,
    attempt_points smallint DEFAULT 2 NOT NULL,
    independent_correct_bonus smallint DEFAULT 3 NOT NULL,
    set_completion_points smallint DEFAULT 5 NOT NULL,
    min_meaningful_response_ms integer DEFAULT 1500 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_rules_attempt_points_check CHECK (((attempt_points >= 0) AND (attempt_points <= 100))),
    CONSTRAINT reward_rules_independent_correct_bonus_check CHECK (((independent_correct_bonus >= 0) AND (independent_correct_bonus <= 100))),
    CONSTRAINT reward_rules_min_meaningful_floor CHECK ((min_meaningful_response_ms >= 500)),
    CONSTRAINT reward_rules_min_meaningful_response_ms_check CHECK (((min_meaningful_response_ms >= 0) AND (min_meaningful_response_ms <= 60000))),
    CONSTRAINT reward_rules_set_completion_points_check CHECK (((set_completion_points >= 0) AND (set_completion_points <= 100)))
);


--
-- Name: rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rewards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid,
    title text NOT NULL,
    point_cost integer NOT NULL,
    instructions text,
    image_path text,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rewards_image_path_check CHECK ((char_length(image_path) <= 300)),
    CONSTRAINT rewards_instructions_check CHECK ((char_length(instructions) <= 500)),
    CONSTRAINT rewards_point_cost_check CHECK (((point_cost >= 1) AND (point_cost <= 1000000))),
    CONSTRAINT rewards_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 80)))
);


--
-- Name: safety_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.safety_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid,
    reporter_kind text NOT NULL,
    category text NOT NULL,
    question_id uuid,
    feedback_id uuid,
    note text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    triaged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolution_note text,
    transcription_at timestamp with time zone,
    screen_categories text[],
    screen_version text,
    family_visible boolean DEFAULT true NOT NULL,
    resolution text,
    parent_action_at timestamp with time zone,
    parent_action_by uuid,
    parent_emailed_at timestamp with time zone,
    parent_email_status text DEFAULT 'not_sent'::text NOT NULL,
    CONSTRAINT safety_reports_category_check CHECK ((category = ANY (ARRAY['unsafe_content'::text, 'wrong_or_confusing'::text, 'upsetting'::text, 'answer_revealed'::text, 'other'::text, 'severe_risk'::text]))),
    CONSTRAINT safety_reports_hold_kind CHECK ((family_visible OR (reporter_kind = ANY (ARRAY['system'::text, 'child'::text])))),
    CONSTRAINT safety_reports_linked_item_has_child CHECK ((((question_id IS NULL) AND (feedback_id IS NULL)) OR (child_id IS NOT NULL))),
    CONSTRAINT safety_reports_note_check CHECK ((char_length(note) <= 500)),
    CONSTRAINT safety_reports_parent_action_shape CHECK ((((parent_action_at IS NULL) OR (resolution IS NOT NULL)) AND ((parent_action_by IS NULL) OR (parent_action_at IS NOT NULL)))),
    CONSTRAINT safety_reports_parent_email_shape CHECK (((parent_email_status = 'sent'::text) = (parent_emailed_at IS NOT NULL))),
    CONSTRAINT safety_reports_parent_email_status_check CHECK ((parent_email_status = ANY (ARRAY['sent'::text, 'not_sent'::text, 'failed'::text]))),
    CONSTRAINT safety_reports_reporter_kind_check CHECK ((reporter_kind = ANY (ARRAY['child'::text, 'parent'::text, 'system'::text]))),
    CONSTRAINT safety_reports_resolution_check CHECK ((resolution = ANY (ARRAY['false_match'::text, 'addressed'::text]))),
    CONSTRAINT safety_reports_resolution_shape CHECK (((resolution IS NULL) OR ((status = 'resolved'::text) AND (((resolution = 'false_match'::text) AND (reporter_kind = 'system'::text)) OR ((resolution = 'addressed'::text) AND (reporter_kind = ANY (ARRAY['system'::text, 'child'::text]))))))),
    CONSTRAINT safety_reports_screen_version_check CHECK ((char_length(screen_version) <= 40)),
    CONSTRAINT safety_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triaged'::text, 'escalated'::text, 'resolved'::text]))),
    CONSTRAINT safety_reports_system_shape CHECK ((((reporter_kind = 'system'::text) = (category = 'severe_risk'::text)) AND ((reporter_kind <> 'system'::text) OR ((child_id IS NOT NULL) AND (question_id IS NOT NULL) AND (note IS NULL) AND (status = ANY (ARRAY['escalated'::text, 'resolved'::text])) AND (transcription_at IS NOT NULL) AND (screen_version IS NOT NULL) AND (screen_categories IS NOT NULL) AND ((cardinality(screen_categories) >= 1) AND (cardinality(screen_categories) <= 6)) AND (screen_categories <@ ARRAY['self_harm'::text, 'abuse'::text, 'violence'::text, 'sexual'::text, 'secrecy'::text, 'personal_contact'::text]))) AND ((reporter_kind = 'system'::text) OR ((transcription_at IS NULL) AND (screen_categories IS NULL) AND (screen_version IS NULL)))))
);


--
-- Name: school_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admins (
    school_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: school_referral_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_referral_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    code_normalized text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_referral_codes_code_normalized_check CHECK ((code_normalized ~ '^[0-9A-Z]{6,16}$'::text))
);


--
-- Name: schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    city text,
    region text,
    status text DEFAULT 'pending_verification'::text NOT NULL,
    recipient_verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schools_city_check CHECK ((char_length(city) <= 80)),
    CONSTRAINT schools_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 160))),
    CONSTRAINT schools_region_check CHECK ((char_length(region) <= 40)),
    CONSTRAINT schools_status_check CHECK ((status = ANY (ARRAY['pending_verification'::text, 'active'::text, 'inactive'::text])))
);


--
-- Name: source_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assignment_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    page_number smallint NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    byte_size integer NOT NULL,
    width integer,
    height integer,
    sha256 text NOT NULL,
    metadata_stripped boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    storage_removed_at timestamp with time zone,
    CONSTRAINT source_pages_byte_size_check CHECK (((byte_size >= 1) AND (byte_size <= 15728640))),
    CONSTRAINT source_pages_height_check CHECK ((height > 0)),
    CONSTRAINT source_pages_mime_type_check CHECK ((mime_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/heic'::text, 'application/pdf'::text]))),
    CONSTRAINT source_pages_page_number_check CHECK (((page_number >= 1) AND (page_number <= 50))),
    CONSTRAINT source_pages_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_pages_width_check CHECK ((width > 0))
);


--
-- Name: spend_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spend_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text DEFAULT 'global'::text NOT NULL,
    period_key text NOT NULL,
    budget_micros bigint NOT NULL,
    alert_thresholds_percent smallint[] DEFAULT '{50,80,100}'::smallint[] NOT NULL,
    alerted_thresholds_percent smallint[] DEFAULT '{}'::smallint[] NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT spend_budgets_budget_micros_check CHECK ((budget_micros > 0)),
    CONSTRAINT spend_budgets_scope_check CHECK ((scope = 'global'::text))
);


--
-- Name: study_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    subject_id uuid,
    kind text NOT NULL,
    content_text text,
    storage_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT study_materials_check CHECK (((content_text IS NOT NULL) OR (storage_path IS NOT NULL))),
    CONSTRAINT study_materials_content_text_check CHECK ((char_length(content_text) <= 20000)),
    CONSTRAINT study_materials_kind_check CHECK ((kind = ANY (ARRAY['spelling_list'::text, 'study_guide'::text, 'taught_notes'::text, 'reading_passage'::text])))
);


--
-- Name: support_case_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_case_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    author_kind text NOT NULL,
    author_user_id uuid,
    body text NOT NULL,
    internal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_case_messages_author_kind_check CHECK ((author_kind = ANY (ARRAY['parent'::text, 'admin'::text]))),
    CONSTRAINT support_case_messages_body_check CHECK (((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 2000))),
    CONSTRAINT support_case_messages_internal_admin CHECK (((NOT internal) OR (author_kind = 'admin'::text))),
    CONSTRAINT support_case_messages_parent_author CHECK (((author_kind <> 'parent'::text) OR (author_user_id IS NOT NULL)))
);


--
-- Name: COLUMN support_case_messages.author_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_case_messages.author_user_id IS 'Pseudonymous author id. Stays after the account closes (Supabase soft delete, 0830); required for parent messages.';


--
-- Name: support_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    opened_by_user_id uuid,
    opened_by_kind text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    channel text,
    provider_period_id text,
    assignee_user_id uuid,
    resolution text,
    resolution_reference text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT support_cases_body_check CHECK (((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 2000))),
    CONSTRAINT support_cases_kind_check CHECK ((kind = ANY (ARRAY['complaint'::text, 'refund_request'::text, 'billing_issue'::text, 'bug'::text, 'safety_question'::text, 'other'::text]))),
    CONSTRAINT support_cases_opened_by_kind_check CHECK ((opened_by_kind = ANY (ARRAY['parent'::text, 'admin'::text]))),
    CONSTRAINT support_cases_parent_author CHECK (((opened_by_kind <> 'parent'::text) OR (opened_by_user_id IS NOT NULL))),
    CONSTRAINT support_cases_period_kind CHECK (((provider_period_id IS NULL) OR (kind = 'refund_request'::text))),
    CONSTRAINT support_cases_period_shape CHECK (((channel IS NULL) = (provider_period_id IS NULL))),
    CONSTRAINT support_cases_priority_check CHECK ((priority = ANY (ARRAY['normal'::text, 'high'::text]))),
    CONSTRAINT support_cases_provider_period_id_check CHECK (((char_length(provider_period_id) >= 1) AND (char_length(provider_period_id) <= 200))),
    CONSTRAINT support_cases_resolution_check CHECK ((resolution = ANY (ARRAY['answered'::text, 'fixed'::text, 'refunded_by_store'::text, 'stripe_refund_issued'::text, 'no_refund'::text, 'duplicate'::text]))),
    CONSTRAINT support_cases_resolution_reference_check CHECK (((char_length(btrim(resolution_reference)) >= 1) AND (char_length(btrim(resolution_reference)) <= 200))),
    CONSTRAINT support_cases_resolution_status CHECK (((resolution IS NULL) OR (status = ANY (ARRAY['resolved'::text, 'closed'::text])))),
    CONSTRAINT support_cases_resolved_needs_resolution CHECK (((status <> 'resolved'::text) OR (resolution IS NOT NULL))),
    CONSTRAINT support_cases_resolved_stamp CHECK (((status = ANY (ARRAY['resolved'::text, 'closed'::text])) = (resolved_at IS NOT NULL))),
    CONSTRAINT support_cases_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'waiting_on_parent'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT support_cases_stripe_reference CHECK (((resolution IS DISTINCT FROM 'stripe_refund_issued'::text) OR (resolution_reference IS NOT NULL))),
    CONSTRAINT support_cases_subject_check CHECK (((char_length(btrim(subject)) >= 1) AND (char_length(btrim(subject)) <= 120)))
);


--
-- Name: COLUMN support_cases.opened_by_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.support_cases.opened_by_user_id IS 'Pseudonymous author id. Stays after the account closes (Supabase soft delete, 0830); required for parent-opened cases.';


--
-- Name: target_answer_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.target_answer_attempts (
    question_instance_id uuid NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    count smallint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT target_answer_attempts_count_check CHECK ((count >= 0))
);


--
-- Name: test_dates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_dates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    test_date date NOT NULL,
    scope_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT test_dates_scope_notes_check CHECK ((char_length(scope_notes) <= 2000))
);


--
-- Name: usage_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    child_id uuid,
    period_key text NOT NULL,
    units integer NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    release_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_reservations_check CHECK (((status = 'released'::text) = (release_reason IS NOT NULL))),
    CONSTRAINT usage_reservations_idempotency_key_check CHECK (((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT usage_reservations_period_key_check CHECK (((char_length(period_key) >= 1) AND (char_length(period_key) <= 80))),
    CONSTRAINT usage_reservations_release_reason_check CHECK ((release_reason = ANY (ARRAY['unreadable'::text, 'cancelled'::text, 'failed_final'::text]))),
    CONSTRAINT usage_reservations_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'committed'::text, 'released'::text]))),
    CONSTRAINT usage_reservations_units_check CHECK ((units > 0))
);


--
-- Name: adult_unlocks adult_unlocks_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.adult_unlocks
    ADD CONSTRAINT adult_unlocks_pkey PRIMARY KEY (id);


--
-- Name: ai_spend_holds ai_spend_holds_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.ai_spend_holds
    ADD CONSTRAINT ai_spend_holds_pkey PRIMARY KEY (id);


--
-- Name: child_pairing_codes child_pairing_codes_code_hash_key; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pairing_codes
    ADD CONSTRAINT child_pairing_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: child_pairing_codes child_pairing_codes_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pairing_codes
    ADD CONSTRAINT child_pairing_codes_pkey PRIMARY KEY (id);


--
-- Name: child_pins child_pins_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pins
    ADD CONSTRAINT child_pins_pkey PRIMARY KEY (child_id);


--
-- Name: child_refresh_tokens child_refresh_tokens_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_refresh_tokens
    ADD CONSTRAINT child_refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: child_refresh_tokens child_refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_refresh_tokens
    ADD CONSTRAINT child_refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: deployment deployment_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.deployment
    ADD CONSTRAINT deployment_pkey PRIMARY KEY (singleton);


--
-- Name: ended_auth_sessions ended_auth_sessions_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.ended_auth_sessions
    ADD CONSTRAINT ended_auth_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: guardian_invitation_tokens guardian_invitation_tokens_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.guardian_invitation_tokens
    ADD CONSTRAINT guardian_invitation_tokens_pkey PRIMARY KEY (invitation_id);


--
-- Name: guardian_invitation_tokens guardian_invitation_tokens_token_hash_key; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.guardian_invitation_tokens
    ADD CONSTRAINT guardian_invitation_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: known_time_zones known_time_zones_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.known_time_zones
    ADD CONSTRAINT known_time_zones_pkey PRIMARY KEY (name);


--
-- Name: parent_pins parent_pins_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.parent_pins
    ADD CONSTRAINT parent_pins_pkey PRIMARY KEY (user_id);


--
-- Name: placement_serves placement_serves_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.placement_serves
    ADD CONSTRAINT placement_serves_pkey PRIMARY KEY (serve_token_hash);


--
-- Name: practice_item_keys practice_item_keys_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.practice_item_keys
    ADD CONSTRAINT practice_item_keys_pkey PRIMARY KEY (item_id);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (device_id);


--
-- Name: question_solutions question_solutions_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.question_solutions
    ADD CONSTRAINT question_solutions_pkey PRIMARY KEY (question_id);


--
-- Name: rate_limit_buckets rate_limit_buckets_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key);


--
-- Name: storage_removals storage_removals_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.storage_removals
    ADD CONSTRAINT storage_removals_pkey PRIMARY KEY (id);


--
-- Name: sweep_runs sweep_runs_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.sweep_runs
    ADD CONSTRAINT sweep_runs_pkey PRIMARY KEY (sweep, run_key);


--
-- Name: template_answer_specs template_answer_specs_pkey; Type: CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.template_answer_specs
    ADD CONSTRAINT template_answer_specs_pkey PRIMARY KEY (template_id);


--
-- Name: ad_reports ad_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_reports
    ADD CONSTRAINT ad_reports_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (user_id);


--
-- Name: aggregate_ad_events aggregate_ad_events_cell; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregate_ad_events
    ADD CONSTRAINT aggregate_ad_events_cell UNIQUE NULLS NOT DISTINCT (campaign_id, catalog_id, event_date, platform, placement, kind);


--
-- Name: aggregate_ad_events aggregate_ad_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregate_ad_events
    ADD CONSTRAINT aggregate_ad_events_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_events ai_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_pkey PRIMARY KEY (id);


--
-- Name: assignments assignments_id_family_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_id_family_id_key UNIQUE (id, family_id);


--
-- Name: assignments assignments_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: assignments assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_pkey PRIMARY KEY (id);


--
-- Name: attempt_overrides attempt_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_overrides
    ADD CONSTRAINT attempt_overrides_pkey PRIMARY KEY (id);


--
-- Name: attempts attempts_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: attempts attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_pkey PRIMARY KEY (id);


--
-- Name: attempts attempts_question_instance_id_attempt_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_question_instance_id_attempt_number_key UNIQUE (question_instance_id, attempt_number);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: billing_periods billing_periods_channel_provider_period_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_periods
    ADD CONSTRAINT billing_periods_channel_provider_period_id_key UNIQUE (channel, provider_period_id);


--
-- Name: billing_periods billing_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_periods
    ADD CONSTRAINT billing_periods_pkey PRIMARY KEY (id);


--
-- Name: billing_provider_events billing_provider_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_provider_events
    ADD CONSTRAINT billing_provider_events_pkey PRIMARY KEY (id);


--
-- Name: billing_provider_events billing_provider_events_provider_provider_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_provider_events
    ADD CONSTRAINT billing_provider_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);


--
-- Name: capacity_changes capacity_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_changes
    ADD CONSTRAINT capacity_changes_pkey PRIMARY KEY (id);


--
-- Name: child_devices child_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_devices
    ADD CONSTRAINT child_devices_pkey PRIMARY KEY (id);


--
-- Name: child_feedback child_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_feedback
    ADD CONSTRAINT child_feedback_pkey PRIMARY KEY (id);


--
-- Name: child_profiles child_profiles_id_family_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_id_family_id_key UNIQUE (id, family_id);


--
-- Name: child_profiles child_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_pkey PRIMARY KEY (id);


--
-- Name: child_sessions child_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_sessions
    ADD CONSTRAINT child_sessions_pkey PRIMARY KEY (id);


--
-- Name: child_slot_assignments child_slot_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_slot_assignments
    ADD CONSTRAINT child_slot_assignments_pkey PRIMARY KEY (id);


--
-- Name: child_subjects child_subjects_id_child_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_subjects
    ADD CONSTRAINT child_subjects_id_child_key UNIQUE (id, child_id);


--
-- Name: child_subjects child_subjects_id_family_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_subjects
    ADD CONSTRAINT child_subjects_id_family_id_key UNIQUE (id, family_id);


--
-- Name: child_subjects child_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_subjects
    ADD CONSTRAINT child_subjects_pkey PRIMARY KEY (id);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: data_exports data_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_pkey PRIMARY KEY (id);


--
-- Name: deletion_requests deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: donation_accruals donation_accruals_billing_period_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_billing_period_id_key UNIQUE (billing_period_id);


--
-- Name: donation_accruals donation_accruals_family_id_donation_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_family_id_donation_month_key UNIQUE (family_id, donation_month);


--
-- Name: donation_accruals donation_accruals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_pkey PRIMARY KEY (id);


--
-- Name: donation_adjustments donation_adjustments_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_adjustments
    ADD CONSTRAINT donation_adjustments_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: donation_adjustments donation_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_adjustments
    ADD CONSTRAINT donation_adjustments_pkey PRIMARY KEY (id);


--
-- Name: donation_payout_batches donation_payout_batches_batch_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_payout_batches
    ADD CONSTRAINT donation_payout_batches_batch_key_key UNIQUE (batch_key);


--
-- Name: donation_payout_batches donation_payout_batches_external_transfer_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_payout_batches
    ADD CONSTRAINT donation_payout_batches_external_transfer_ref_key UNIQUE (external_transfer_ref);


--
-- Name: donation_payout_batches donation_payout_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_payout_batches
    ADD CONSTRAINT donation_payout_batches_pkey PRIMARY KEY (id);


--
-- Name: extracted_questions extracted_questions_assignment_id_page_id_question_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_assignment_id_page_id_question_number_key UNIQUE (assignment_id, page_id, question_number);


--
-- Name: extracted_questions extracted_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_pkey PRIMARY KEY (id);


--
-- Name: families families_billing_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_billing_ref_key UNIQUE (billing_ref);


--
-- Name: families families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_pkey PRIMARY KEY (id);


--
-- Name: family_capacity family_capacity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_capacity
    ADD CONSTRAINT family_capacity_pkey PRIMARY KEY (family_id);


--
-- Name: family_entitlements family_entitlements_channel_provider_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_entitlements
    ADD CONSTRAINT family_entitlements_channel_provider_subscription_id_key UNIQUE (channel, provider_subscription_id);


--
-- Name: family_entitlements family_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_entitlements
    ADD CONSTRAINT family_entitlements_pkey PRIMARY KEY (id);


--
-- Name: family_memberships family_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_memberships
    ADD CONSTRAINT family_memberships_pkey PRIMARY KEY (id);


--
-- Name: family_monetization_prefs family_monetization_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_monetization_prefs
    ADD CONSTRAINT family_monetization_prefs_pkey PRIMARY KEY (family_id);


--
-- Name: family_school_attributions family_school_attributions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_attributions
    ADD CONSTRAINT family_school_attributions_pkey PRIMARY KEY (id);


--
-- Name: family_school_designations family_school_designations_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_designations
    ADD CONSTRAINT family_school_designations_no_overlap EXCLUDE USING gist (family_id WITH =, daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)'::text) WITH &&);


--
-- Name: family_school_designations family_school_designations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_designations
    ADD CONSTRAINT family_school_designations_pkey PRIMARY KEY (id);


--
-- Name: guardian_invitations guardian_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_invitations
    ADD CONSTRAINT guardian_invitations_pkey PRIMARY KEY (id);


--
-- Name: identity_declarations identity_declarations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_declarations
    ADD CONSTRAINT identity_declarations_pkey PRIMARY KEY (id);


--
-- Name: identity_verifications identity_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_verifications
    ADD CONSTRAINT identity_verifications_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: learning_schedules learning_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_schedules
    ADD CONSTRAINT learning_schedules_pkey PRIMARY KEY (child_id);


--
-- Name: monetization_approvals monetization_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monetization_approvals
    ADD CONSTRAINT monetization_approvals_pkey PRIMARY KEY (id);


--
-- Name: monetization_switches monetization_switches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monetization_switches
    ADD CONSTRAINT monetization_switches_pkey PRIMARY KEY (key);


--
-- Name: notification_deliveries notification_deliveries_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_devices notification_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_devices
    ADD CONSTRAINT notification_devices_pkey PRIMARY KEY (id);


--
-- Name: ops_settings ops_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_settings
    ADD CONSTRAINT ops_settings_pkey PRIMARY KEY (key);


--
-- Name: pending_refunds pending_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_refunds
    ADD CONSTRAINT pending_refunds_pkey PRIMARY KEY (channel, provider_period_id);


--
-- Name: placement_rules placement_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_rules
    ADD CONSTRAINT placement_rules_pkey PRIMARY KEY (placement);


--
-- Name: point_balances point_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_balances
    ADD CONSTRAINT point_balances_pkey PRIMARY KEY (child_id);


--
-- Name: points_ledger points_ledger_child_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_child_id_idempotency_key_key UNIQUE (child_id, idempotency_key);


--
-- Name: points_ledger points_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_pkey PRIMARY KEY (id);


--
-- Name: practice_items practice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_pkey PRIMARY KEY (id);


--
-- Name: practice_items practice_items_set_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_set_id_position_key UNIQUE (set_id, "position");


--
-- Name: practice_sets practice_sets_id_family_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_sets
    ADD CONSTRAINT practice_sets_id_family_id_key UNIQUE (id, family_id);


--
-- Name: practice_sets practice_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_sets
    ADD CONSTRAINT practice_sets_pkey PRIMARY KEY (id);


--
-- Name: practice_sets practice_sets_set_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_sets
    ADD CONSTRAINT practice_sets_set_key_key UNIQUE (set_key);


--
-- Name: promo_benefit_periods promo_benefit_periods_channel_provider_period_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_channel_provider_period_id_key UNIQUE (channel, provider_period_id);


--
-- Name: promo_benefit_periods promo_benefit_periods_family_id_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_family_id_period_start_key UNIQUE (family_id, period_start);


--
-- Name: promo_benefit_periods promo_benefit_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_pkey PRIMARY KEY (id);


--
-- Name: promo_benefit_periods promo_benefit_periods_redemption_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_redemption_id_key UNIQUE (redemption_id);


--
-- Name: promo_campaign_templates promo_campaign_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaign_templates
    ADD CONSTRAINT promo_campaign_templates_pkey PRIMARY KEY (id);


--
-- Name: promo_campaigns promo_campaigns_generation_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaigns
    ADD CONSTRAINT promo_campaigns_generation_key_key UNIQUE (generation_key);


--
-- Name: promo_campaigns promo_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaigns
    ADD CONSTRAINT promo_campaigns_pkey PRIMARY KEY (id);


--
-- Name: promo_campaigns promo_campaigns_template_id_campaign_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaigns
    ADD CONSTRAINT promo_campaigns_template_id_campaign_month_key UNIQUE (template_id, campaign_month);


--
-- Name: promo_codes promo_codes_code_normalized_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_code_normalized_key UNIQUE (code_normalized);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);


--
-- Name: promo_redemptions promo_redemptions_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: promo_redemptions promo_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_pkey PRIMARY KEY (id);


--
-- Name: provider_offer_mappings provider_offer_mappings_campaign_id_channel_paid_slots_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_offer_mappings
    ADD CONSTRAINT provider_offer_mappings_campaign_id_channel_paid_slots_key UNIQUE (campaign_id, channel, paid_slots);


--
-- Name: provider_offer_mappings provider_offer_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_offer_mappings
    ADD CONSTRAINT provider_offer_mappings_pkey PRIMARY KEY (id);


--
-- Name: question_results question_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_results
    ADD CONSTRAINT question_results_pkey PRIMARY KEY (question_id);


--
-- Name: question_templates question_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_templates
    ADD CONSTRAINT question_templates_pkey PRIMARY KEY (id);


--
-- Name: question_templates question_templates_template_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_templates
    ADD CONSTRAINT question_templates_template_key_key UNIQUE (template_key);


--
-- Name: resource_catalog resource_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_catalog
    ADD CONSTRAINT resource_catalog_pkey PRIMARY KEY (id);


--
-- Name: resource_catalog resource_catalog_stable_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_catalog
    ADD CONSTRAINT resource_catalog_stable_key_key UNIQUE (stable_key);


--
-- Name: revenue_adjustments revenue_adjustments_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_adjustments
    ADD CONSTRAINT revenue_adjustments_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: revenue_adjustments revenue_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_adjustments
    ADD CONSTRAINT revenue_adjustments_pkey PRIMARY KEY (id);


--
-- Name: revenue_entries revenue_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_pkey PRIMARY KEY (id);


--
-- Name: revenue_entries revenue_entries_provider_external_ref_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_provider_external_ref_category_key UNIQUE (provider, external_ref, category);


--
-- Name: revenue_entries revenue_entries_source_external_ref_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_source_external_ref_category_key UNIQUE (source, external_ref, category);


--
-- Name: revenue_imports revenue_imports_file_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_imports
    ADD CONSTRAINT revenue_imports_file_sha256_key UNIQUE (file_sha256);


--
-- Name: revenue_imports revenue_imports_id_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_imports
    ADD CONSTRAINT revenue_imports_id_source_key UNIQUE (id, source);


--
-- Name: revenue_imports revenue_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_imports
    ADD CONSTRAINT revenue_imports_pkey PRIMARY KEY (id);


--
-- Name: reward_redemptions reward_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_redemptions
    ADD CONSTRAINT reward_redemptions_pkey PRIMARY KEY (id);


--
-- Name: reward_rules reward_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_rules
    ADD CONSTRAINT reward_rules_pkey PRIMARY KEY (family_id);


--
-- Name: rewards rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards
    ADD CONSTRAINT rewards_pkey PRIMARY KEY (id);


--
-- Name: safety_reports safety_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_pkey PRIMARY KEY (id);


--
-- Name: school_admins school_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admins
    ADD CONSTRAINT school_admins_pkey PRIMARY KEY (school_id, user_id);


--
-- Name: school_referral_codes school_referral_codes_code_normalized_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_referral_codes
    ADD CONSTRAINT school_referral_codes_code_normalized_key UNIQUE (code_normalized);


--
-- Name: school_referral_codes school_referral_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_referral_codes
    ADD CONSTRAINT school_referral_codes_pkey PRIMARY KEY (id);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: source_pages source_pages_assignment_id_page_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_assignment_id_page_number_key UNIQUE (assignment_id, page_number);


--
-- Name: source_pages source_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_pkey PRIMARY KEY (id);


--
-- Name: source_pages source_pages_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_storage_path_key UNIQUE (storage_path);


--
-- Name: spend_budgets spend_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend_budgets
    ADD CONSTRAINT spend_budgets_pkey PRIMARY KEY (id);


--
-- Name: spend_budgets spend_budgets_scope_period_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend_budgets
    ADD CONSTRAINT spend_budgets_scope_period_key_key UNIQUE (scope, period_key);


--
-- Name: sponsor_campaigns sponsor_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_campaigns
    ADD CONSTRAINT sponsor_campaigns_pkey PRIMARY KEY (id);


--
-- Name: sponsor_creatives sponsor_creatives_id_sponsor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_id_sponsor_id_key UNIQUE (id, sponsor_id);


--
-- Name: sponsor_creatives sponsor_creatives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_pkey PRIMARY KEY (id);


--
-- Name: sponsor_creatives sponsor_creatives_sponsor_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_sponsor_id_version_key UNIQUE (sponsor_id, version);


--
-- Name: sponsors sponsors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsors
    ADD CONSTRAINT sponsors_pkey PRIMARY KEY (id);


--
-- Name: store_feature_mappings store_feature_mappings_channel_product_id_environment_featu_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_feature_mappings
    ADD CONSTRAINT store_feature_mappings_channel_product_id_environment_featu_key UNIQUE (channel, product_id, environment, feature);


--
-- Name: store_feature_mappings store_feature_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_feature_mappings
    ADD CONSTRAINT store_feature_mappings_pkey PRIMARY KEY (id);


--
-- Name: store_product_mappings store_product_mappings_channel_product_id_base_plan_id_envi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_mappings
    ADD CONSTRAINT store_product_mappings_channel_product_id_base_plan_id_envi_key UNIQUE (channel, product_id, base_plan_id, environment);


--
-- Name: store_product_mappings store_product_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_product_mappings
    ADD CONSTRAINT store_product_mappings_pkey PRIMARY KEY (id);


--
-- Name: study_materials study_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_pkey PRIMARY KEY (id);


--
-- Name: support_case_messages support_case_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_messages
    ADD CONSTRAINT support_case_messages_pkey PRIMARY KEY (id);


--
-- Name: support_cases support_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_pkey PRIMARY KEY (id);


--
-- Name: target_answer_attempts target_answer_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.target_answer_attempts
    ADD CONSTRAINT target_answer_attempts_pkey PRIMARY KEY (question_instance_id);


--
-- Name: test_dates test_dates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_pkey PRIMARY KEY (id);


--
-- Name: test_dates test_dates_subject_id_test_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_subject_id_test_date_key UNIQUE (subject_id, test_date);


--
-- Name: usage_reservations usage_reservations_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: usage_reservations usage_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_pkey PRIMARY KEY (id);


--
-- Name: adult_unlocks_lookup; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX adult_unlocks_lookup ON private.adult_unlocks USING btree (user_id, auth_session_id, expires_at);


--
-- Name: ai_spend_holds_period; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX ai_spend_holds_period ON private.ai_spend_holds USING btree (period_key, expires_at);


--
-- Name: child_pairing_codes_family_child; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX child_pairing_codes_family_child ON private.child_pairing_codes USING btree (family_id, child_id);


--
-- Name: child_pairing_codes_one_live_per_child; Type: INDEX; Schema: private; Owner: -
--

CREATE UNIQUE INDEX child_pairing_codes_one_live_per_child ON private.child_pairing_codes USING btree (child_id) WHERE (consumed_at IS NULL);


--
-- Name: child_refresh_tokens_session; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX child_refresh_tokens_session ON private.child_refresh_tokens USING btree (session_id);


--
-- Name: ended_auth_sessions_ended_at; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX ended_auth_sessions_ended_at ON private.ended_auth_sessions USING btree (ended_at);


--
-- Name: placement_serves_retention; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX placement_serves_retention ON private.placement_serves USING btree (served_at);


--
-- Name: placement_serves_session; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX placement_serves_session ON private.placement_serves USING btree (session_key_hash, served_at);


--
-- Name: rate_limit_buckets_expiry; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX rate_limit_buckets_expiry ON private.rate_limit_buckets USING btree (expires_at);


--
-- Name: storage_removals_due; Type: INDEX; Schema: private; Owner: -
--

CREATE INDEX storage_removals_due ON private.storage_removals USING btree (remove_after);


--
-- Name: ai_usage_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_events_created ON public.ai_usage_events USING btree (created_at) INCLUDE (cost_micros);


--
-- Name: ai_usage_events_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_events_family ON public.ai_usage_events USING btree (family_id, created_at DESC);


--
-- Name: assignments_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assignments_child ON public.assignments USING btree (child_id, created_at DESC);


--
-- Name: assignments_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assignments_family_created ON public.assignments USING btree (family_id, created_at DESC);


--
-- Name: attempt_overrides_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attempt_overrides_attempt ON public.attempt_overrides USING btree (attempt_id, created_at DESC);


--
-- Name: attempts_child_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attempts_child_skill ON public.attempts USING btree (child_id, skill, occurred_at DESC);


--
-- Name: attempts_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attempts_family_created ON public.attempts USING btree (family_id, created_at DESC);


--
-- Name: audit_events_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_family ON public.audit_events USING btree (family_id, created_at DESC);


--
-- Name: billing_periods_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_periods_family ON public.billing_periods USING btree (family_id, period_start DESC);


--
-- Name: capacity_changes_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capacity_changes_family ON public.capacity_changes USING btree (family_id, created_at DESC);


--
-- Name: child_devices_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_devices_family ON public.child_devices USING btree (family_id, paired_at DESC);


--
-- Name: child_feedback_question; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_feedback_question ON public.child_feedback USING btree (question_id, created_at);


--
-- Name: child_profiles_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_profiles_family ON public.child_profiles USING btree (family_id);


--
-- Name: child_sessions_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_sessions_child ON public.child_sessions USING btree (child_id) WHERE (revoked_at IS NULL);


--
-- Name: child_sessions_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_sessions_family ON public.child_sessions USING btree (family_id) WHERE (revoked_at IS NULL);


--
-- Name: child_slot_assignments_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX child_slot_assignments_one_open ON public.child_slot_assignments USING btree (child_id) WHERE (released_at IS NULL);


--
-- Name: child_subjects_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX child_subjects_family_created ON public.child_subjects USING btree (family_id, created_at DESC);


--
-- Name: child_subjects_unique_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX child_subjects_unique_name ON public.child_subjects USING btree (child_id, lower(display_name));


--
-- Name: consent_records_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consent_records_family ON public.consent_records USING btree (family_id, created_at DESC);


--
-- Name: data_exports_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_exports_family ON public.data_exports USING btree (family_id, created_at DESC);


--
-- Name: deletion_requests_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deletion_requests_one_open ON public.deletion_requests USING btree (family_id, COALESCE(target_child_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = ANY (ARRAY['requested'::text, 'processing'::text]));


--
-- Name: donation_accruals_school_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX donation_accruals_school_month ON public.donation_accruals USING btree (school_id, donation_month);


--
-- Name: extracted_questions_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX extracted_questions_assignment ON public.extracted_questions USING btree (assignment_id);


--
-- Name: family_entitlements_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_entitlements_family ON public.family_entitlements USING btree (family_id);


--
-- Name: family_memberships_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_memberships_family ON public.family_memberships USING btree (family_id);


--
-- Name: family_memberships_one_active_family_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_memberships_one_active_family_per_user ON public.family_memberships USING btree (user_id) WHERE (status = 'active'::text);


--
-- Name: family_memberships_one_active_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_memberships_one_active_owner ON public.family_memberships USING btree (family_id) WHERE ((status = 'active'::text) AND (role = 'owner'::text));


--
-- Name: family_memberships_one_active_per_user_family; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_memberships_one_active_per_user_family ON public.family_memberships USING btree (family_id, user_id) WHERE (status = 'active'::text);


--
-- Name: family_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_memberships_user ON public.family_memberships USING btree (user_id) WHERE (status = 'active'::text);


--
-- Name: family_school_attributions_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX family_school_attributions_current ON public.family_school_attributions USING btree (family_id) WHERE (superseded_at IS NULL);


--
-- Name: guardian_invitations_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX guardian_invitations_one_pending ON public.guardian_invitations USING btree (family_id, email) WHERE (status = 'pending'::text);


--
-- Name: identity_declarations_established_adult; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_declarations_established_adult ON public.identity_declarations USING btree (adult_user_id, checked_at DESC) WHERE adult_declared;


--
-- Name: identity_declarations_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_declarations_family ON public.identity_declarations USING btree (family_id, checked_at DESC);


--
-- Name: identity_verifications_confirmed_adult; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_verifications_confirmed_adult ON public.identity_verifications USING btree (adult_user_id, checked_at DESC) WHERE adult_confirmed;


--
-- Name: identity_verifications_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_verifications_family ON public.identity_verifications USING btree (family_id, checked_at DESC);


--
-- Name: jobs_family_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_family_child ON public.jobs USING btree (family_id, child_id, kind, created_at DESC);


--
-- Name: jobs_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_ready ON public.jobs USING btree (run_after) WHERE (status = ANY (ARRAY['queued'::text, 'failed_retryable'::text]));


--
-- Name: jobs_running; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_running ON public.jobs USING btree (locked_until) WHERE (status = 'running'::text);


--
-- Name: monetization_approvals_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monetization_approvals_lookup ON public.monetization_approvals USING btree (provider, platform, status);


--
-- Name: points_ledger_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_ledger_child ON public.points_ledger USING btree (child_id, id);


--
-- Name: practice_sets_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX practice_sets_child ON public.practice_sets USING btree (child_id, created_at DESC);


--
-- Name: practice_sets_child_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX practice_sets_child_review ON public.practice_sets USING btree (child_id, kind, review_week, subject_key);


--
-- Name: practice_sets_one_base_review; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX practice_sets_one_base_review ON public.practice_sets USING btree (child_id, subject_key, review_week) WHERE ((kind = 'thursday_review'::text) AND (status = ANY (ARRAY['generating'::text, 'ready'::text, 'in_progress'::text, 'completed'::text])));


--
-- Name: promo_codes_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promo_codes_campaign ON public.promo_codes USING btree (campaign_id);


--
-- Name: promo_redemptions_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promo_redemptions_campaign ON public.promo_redemptions USING btree (campaign_id, state);


--
-- Name: promo_redemptions_once_per_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX promo_redemptions_once_per_campaign ON public.promo_redemptions USING btree (family_id, campaign_id) WHERE (state = ANY (ARRAY['reserved'::text, 'provider_pending'::text, 'confirmed'::text, 'reconciled'::text]));


--
-- Name: promo_redemptions_one_in_flight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX promo_redemptions_one_in_flight ON public.promo_redemptions USING btree (family_id) WHERE (state = ANY (ARRAY['reserved'::text, 'provider_pending'::text]));


--
-- Name: promo_redemptions_one_per_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX promo_redemptions_one_per_period ON public.promo_redemptions USING btree (family_id, target_period_key) WHERE (state = ANY (ARRAY['reserved'::text, 'provider_pending'::text, 'confirmed'::text, 'reconciled'::text]));


--
-- Name: revenue_entries_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX revenue_entries_month ON public.revenue_entries USING btree (period_month);


--
-- Name: reward_redemptions_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reward_redemptions_child ON public.reward_redemptions USING btree (child_id, requested_at DESC);


--
-- Name: reward_redemptions_family_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reward_redemptions_family_state ON public.reward_redemptions USING btree (family_id, state, requested_at);


--
-- Name: rewards_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rewards_family ON public.rewards USING btree (family_id) WHERE active;


--
-- Name: rewards_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rewards_family_created ON public.rewards USING btree (family_id, created_at DESC);


--
-- Name: safety_reports_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX safety_reports_family ON public.safety_reports USING btree (family_id, created_at DESC);


--
-- Name: safety_reports_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX safety_reports_open ON public.safety_reports USING btree (created_at) WHERE (status = ANY (ARRAY['open'::text, 'escalated'::text]));


--
-- Name: safety_reports_system_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX safety_reports_system_once ON public.safety_reports USING btree (question_id, transcription_at) WHERE (reporter_kind = 'system'::text);


--
-- Name: source_pages_storage_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_pages_storage_pending ON public.source_pages USING btree (created_at) WHERE (storage_removed_at IS NULL);


--
-- Name: sponsor_campaigns_serving; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sponsor_campaigns_serving ON public.sponsor_campaigns USING btree (placement, status);


--
-- Name: study_materials_child_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX study_materials_child_created ON public.study_materials USING btree (child_id, created_at DESC);


--
-- Name: study_materials_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX study_materials_family_created ON public.study_materials USING btree (family_id, created_at DESC);


--
-- Name: support_case_messages_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_case_messages_case ON public.support_case_messages USING btree (case_id, created_at, id);


--
-- Name: support_cases_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_family ON public.support_cases USING btree (family_id, created_at DESC);


--
-- Name: support_cases_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_period ON public.support_cases USING btree (channel, provider_period_id) WHERE (provider_period_id IS NOT NULL);


--
-- Name: support_cases_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_queue ON public.support_cases USING btree (status, created_at, id);


--
-- Name: test_dates_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_dates_child ON public.test_dates USING btree (child_id, test_date);


--
-- Name: test_dates_family_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX test_dates_family_created ON public.test_dates USING btree (family_id, created_at DESC);


--
-- Name: usage_reservations_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_reservations_period ON public.usage_reservations USING btree (family_id, period_key);


--
-- Name: child_pairing_codes child_pairing_codes_serialize; Type: TRIGGER; Schema: private; Owner: -
--

CREATE TRIGGER child_pairing_codes_serialize BEFORE INSERT ON private.child_pairing_codes FOR EACH ROW EXECUTE FUNCTION app.child_pairing_codes_before_insert();


--
-- Name: deployment deployment_guard; Type: TRIGGER; Schema: private; Owner: -
--

CREATE TRIGGER deployment_guard BEFORE INSERT OR UPDATE ON private.deployment FOR EACH ROW EXECUTE FUNCTION app.guard_deployment_mark();


--
-- Name: ad_reports ad_reports_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ad_reports_no_delete BEFORE DELETE ON public.ad_reports FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: aggregate_ad_events aggregate_ad_events_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aggregate_ad_events_guard BEFORE DELETE OR UPDATE ON public.aggregate_ad_events FOR EACH ROW EXECUTE FUNCTION app.guard_aggregate_ad_event();


--
-- Name: ai_usage_events ai_usage_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_events_append_only BEFORE DELETE OR UPDATE ON public.ai_usage_events FOR EACH ROW EXECUTE FUNCTION app.guard_ai_usage_event();


--
-- Name: ai_usage_events ai_usage_events_child; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_usage_events_child BEFORE INSERT ON public.ai_usage_events FOR EACH ROW EXECUTE FUNCTION app.pseudonymise_late_usage();


--
-- Name: assignments assignments_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assignments_transition BEFORE UPDATE ON public.assignments FOR EACH ROW EXECUTE FUNCTION app.guard_assignment_transition();


--
-- Name: assignments assignments_uploads_closed; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER assignments_uploads_closed BEFORE INSERT OR UPDATE OF status ON public.assignments FOR EACH ROW EXECUTE FUNCTION app.stamp_uploads_closed();


--
-- Name: attempt_overrides attempt_overrides_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attempt_overrides_append_only BEFORE DELETE OR UPDATE ON public.attempt_overrides FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: attempts attempts_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER attempts_append_only BEFORE DELETE OR UPDATE ON public.attempts FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE DELETE OR UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: billing_periods billing_periods_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER billing_periods_touch BEFORE UPDATE ON public.billing_periods FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: capacity_changes capacity_changes_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capacity_changes_touch BEFORE UPDATE ON public.capacity_changes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: child_feedback child_feedback_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_feedback_append_only BEFORE DELETE OR UPDATE ON public.child_feedback FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: child_profiles child_profiles_end_pairing_codes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_profiles_end_pairing_codes AFTER UPDATE OF status ON public.child_profiles FOR EACH ROW WHEN (((old.status = 'active'::text) AND (new.status IS DISTINCT FROM 'active'::text))) EXECUTE FUNCTION app.child_profiles_end_pairing_codes();


--
-- Name: child_profiles child_profiles_no_activation_under_deletion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_profiles_no_activation_under_deletion BEFORE UPDATE ON public.child_profiles FOR EACH ROW EXECUTE FUNCTION app.child_profiles_no_activation_under_deletion();


--
-- Name: child_profiles child_profiles_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_profiles_touch BEFORE UPDATE ON public.child_profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: child_slot_assignments child_slot_assignments_capacity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_slot_assignments_capacity BEFORE INSERT OR UPDATE OF released_at ON public.child_slot_assignments FOR EACH ROW EXECUTE FUNCTION app.enforce_slot_capacity();


--
-- Name: child_subjects child_subjects_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER child_subjects_data_api_guard BEFORE INSERT OR UPDATE ON public.child_subjects FOR EACH ROW EXECUTE FUNCTION app.data_api_learning_write_guard();


--
-- Name: donation_accruals donation_accruals_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER donation_accruals_guard BEFORE DELETE OR UPDATE ON public.donation_accruals FOR EACH ROW EXECUTE FUNCTION app.guard_ledger_row();


--
-- Name: donation_adjustments donation_adjustments_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER donation_adjustments_guard BEFORE DELETE OR UPDATE ON public.donation_adjustments FOR EACH ROW EXECUTE FUNCTION app.guard_ledger_row();


--
-- Name: families families_timezone_iana; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER families_timezone_iana BEFORE INSERT OR UPDATE OF timezone ON public.families FOR EACH ROW EXECUTE FUNCTION app.families_require_iana_timezone();


--
-- Name: families families_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER families_touch BEFORE UPDATE ON public.families FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: family_capacity family_capacity_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER family_capacity_touch BEFORE UPDATE ON public.family_capacity FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: family_entitlements family_entitlements_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER family_entitlements_touch BEFORE UPDATE ON public.family_entitlements FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: family_memberships family_memberships_adult_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER family_memberships_adult_limit BEFORE INSERT OR UPDATE OF status ON public.family_memberships FOR EACH ROW EXECUTE FUNCTION app.enforce_adult_limit();


--
-- Name: jobs jobs_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jobs_guard BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION app.guard_job();


--
-- Name: learning_schedules learning_schedules_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER learning_schedules_data_api_guard BEFORE INSERT OR UPDATE ON public.learning_schedules FOR EACH ROW EXECUTE FUNCTION app.data_api_learning_write_guard();


--
-- Name: learning_schedules learning_schedules_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER learning_schedules_version BEFORE UPDATE ON public.learning_schedules FOR EACH ROW EXECUTE FUNCTION app.bump_schedule_version_on_change();


--
-- Name: monetization_approvals monetization_approvals_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER monetization_approvals_fixture_guard BEFORE INSERT OR UPDATE ON public.monetization_approvals FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: monetization_approvals monetization_approvals_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER monetization_approvals_guard BEFORE UPDATE ON public.monetization_approvals FOR EACH ROW EXECUTE FUNCTION app.guard_monetization_approval();


--
-- Name: monetization_approvals monetization_approvals_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER monetization_approvals_no_delete BEFORE DELETE ON public.monetization_approvals FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: monetization_switches monetization_switches_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER monetization_switches_no_delete BEFORE DELETE ON public.monetization_switches FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: ops_settings ops_settings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ops_settings_touch BEFORE UPDATE ON public.ops_settings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: placement_rules placement_rules_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER placement_rules_no_delete BEFORE DELETE ON public.placement_rules FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: points_ledger points_ledger_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER points_ledger_append_only BEFORE DELETE OR UPDATE ON public.points_ledger FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: points_ledger points_ledger_apply; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER points_ledger_apply AFTER INSERT ON public.points_ledger FOR EACH ROW EXECUTE FUNCTION app.apply_points_to_balance();


--
-- Name: promo_benefit_periods promo_benefit_periods_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_benefit_periods_append_only BEFORE DELETE OR UPDATE ON public.promo_benefit_periods FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: promo_campaign_templates promo_campaign_templates_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_campaign_templates_touch BEFORE UPDATE ON public.promo_campaign_templates FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: promo_campaigns promo_campaigns_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_campaigns_touch BEFORE UPDATE ON public.promo_campaigns FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: promo_redemptions promo_redemptions_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_redemptions_no_delete BEFORE DELETE ON public.promo_redemptions FOR EACH ROW EXECUTE FUNCTION app.no_delete();


--
-- Name: promo_redemptions promo_redemptions_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_redemptions_touch BEFORE UPDATE ON public.promo_redemptions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: promo_redemptions promo_redemptions_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER promo_redemptions_transition BEFORE UPDATE ON public.promo_redemptions FOR EACH ROW EXECUTE FUNCTION app.guard_redemption_transition();


--
-- Name: provider_offer_mappings provider_offer_mappings_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER provider_offer_mappings_fixture_guard BEFORE INSERT OR UPDATE ON public.provider_offer_mappings FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: resource_catalog resource_catalog_check_reset; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_catalog_check_reset BEFORE UPDATE ON public.resource_catalog FOR EACH ROW EXECUTE FUNCTION app.reset_link_check_on_url_change();


--
-- Name: resource_catalog resource_catalog_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_catalog_fixture_guard BEFORE INSERT OR UPDATE ON public.resource_catalog FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: resource_catalog resource_catalog_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_catalog_no_delete BEFORE DELETE ON public.resource_catalog FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: resource_catalog resource_catalog_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_catalog_touch BEFORE UPDATE ON public.resource_catalog FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: revenue_adjustments revenue_adjustments_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_adjustments_append_only BEFORE DELETE OR UPDATE ON public.revenue_adjustments FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: revenue_adjustments revenue_adjustments_bounds; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_adjustments_bounds BEFORE INSERT ON public.revenue_adjustments FOR EACH ROW EXECUTE FUNCTION app.guard_revenue_adjustment();


--
-- Name: revenue_entries revenue_entries_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_entries_append_only BEFORE DELETE OR UPDATE ON public.revenue_entries FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: revenue_entries revenue_entries_campaign_placement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_entries_campaign_placement BEFORE INSERT ON public.revenue_entries FOR EACH ROW EXECUTE FUNCTION app.guard_revenue_entry_campaign();


--
-- Name: revenue_imports revenue_imports_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_imports_append_only BEFORE DELETE OR UPDATE ON public.revenue_imports FOR EACH ROW EXECUTE FUNCTION app.prevent_mutation();


--
-- Name: reward_redemptions reward_redemptions_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reward_redemptions_guard BEFORE DELETE OR UPDATE ON public.reward_redemptions FOR EACH ROW EXECUTE FUNCTION app.guard_reward_redemption();


--
-- Name: rewards rewards_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rewards_data_api_guard BEFORE INSERT OR UPDATE ON public.rewards FOR EACH ROW EXECUTE FUNCTION app.data_api_reward_write_guard();


--
-- Name: rewards rewards_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rewards_touch BEFORE UPDATE ON public.rewards FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: safety_reports safety_reports_resolution_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER safety_reports_resolution_guard BEFORE UPDATE ON public.safety_reports FOR EACH ROW EXECUTE FUNCTION app.guard_safety_report_resolution();


--
-- Name: source_pages source_pages_late_removal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_pages_late_removal AFTER UPDATE OF storage_removed_at ON public.source_pages FOR EACH ROW EXECUTE FUNCTION app.schedule_late_page_removal();


--
-- Name: sponsor_campaigns sponsor_campaigns_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsor_campaigns_guard BEFORE INSERT OR UPDATE ON public.sponsor_campaigns FOR EACH ROW EXECUTE FUNCTION app.guard_sponsor_campaign();


--
-- Name: sponsor_campaigns sponsor_campaigns_guard_fixture; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsor_campaigns_guard_fixture BEFORE INSERT OR UPDATE ON public.sponsor_campaigns FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: sponsor_campaigns sponsor_campaigns_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsor_campaigns_no_delete BEFORE DELETE ON public.sponsor_campaigns FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: sponsor_creatives sponsor_creatives_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsor_creatives_guard BEFORE INSERT OR UPDATE ON public.sponsor_creatives FOR EACH ROW EXECUTE FUNCTION app.guard_sponsor_creative();


--
-- Name: sponsor_creatives sponsor_creatives_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsor_creatives_no_delete BEFORE DELETE ON public.sponsor_creatives FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: sponsors sponsors_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsors_fixture_guard BEFORE INSERT OR UPDATE ON public.sponsors FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: sponsors sponsors_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsors_no_delete BEFORE DELETE ON public.sponsors FOR EACH ROW EXECUTE FUNCTION app.monetization_no_delete();


--
-- Name: sponsors sponsors_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sponsors_touch BEFORE UPDATE ON public.sponsors FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: store_feature_mappings store_feature_mappings_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER store_feature_mappings_fixture_guard BEFORE INSERT OR UPDATE ON public.store_feature_mappings FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: store_feature_mappings store_feature_mappings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER store_feature_mappings_touch BEFORE UPDATE ON public.store_feature_mappings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: store_product_mappings store_product_mappings_fixture_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER store_product_mappings_fixture_guard BEFORE INSERT OR UPDATE ON public.store_product_mappings FOR EACH ROW EXECUTE FUNCTION app.refuse_fake_catalog_row();


--
-- Name: study_materials study_materials_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER study_materials_data_api_guard BEFORE INSERT ON public.study_materials FOR EACH ROW EXECUTE FUNCTION app.data_api_learning_write_guard();


--
-- Name: support_case_messages support_case_messages_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_case_messages_data_api_guard BEFORE INSERT ON public.support_case_messages FOR EACH ROW EXECUTE FUNCTION app.data_api_support_write_guard();


--
-- Name: support_cases support_cases_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_cases_data_api_guard BEFORE INSERT ON public.support_cases FOR EACH ROW EXECUTE FUNCTION app.data_api_support_write_guard();


--
-- Name: support_cases support_cases_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_cases_touch BEFORE UPDATE ON public.support_cases FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: test_dates test_dates_data_api_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_dates_data_api_delete_guard BEFORE DELETE ON public.test_dates FOR EACH ROW EXECUTE FUNCTION app.data_api_test_date_delete_guard();


--
-- Name: test_dates test_dates_data_api_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_dates_data_api_guard BEFORE INSERT ON public.test_dates FOR EACH ROW EXECUTE FUNCTION app.data_api_learning_write_guard();


--
-- Name: test_dates test_dates_reschedule; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER test_dates_reschedule AFTER INSERT OR DELETE ON public.test_dates FOR EACH ROW EXECUTE FUNCTION app.bump_schedule_version_on_test_date();


--
-- Name: usage_reservations usage_reservations_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_reservations_touch BEFORE UPDATE ON public.usage_reservations FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: usage_reservations usage_reservations_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_reservations_transition BEFORE INSERT OR UPDATE ON public.usage_reservations FOR EACH ROW EXECUTE FUNCTION app.guard_usage_transition();


--
-- Name: adult_unlocks adult_unlocks_user_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.adult_unlocks
    ADD CONSTRAINT adult_unlocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: child_pairing_codes child_pairing_codes_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pairing_codes
    ADD CONSTRAINT child_pairing_codes_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_pairing_codes child_pairing_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pairing_codes
    ADD CONSTRAINT child_pairing_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: child_pairing_codes child_pairing_codes_family_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pairing_codes
    ADD CONSTRAINT child_pairing_codes_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_pins child_pins_child_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_pins
    ADD CONSTRAINT child_pins_child_id_fkey FOREIGN KEY (child_id) REFERENCES public.child_profiles(id);


--
-- Name: child_refresh_tokens child_refresh_tokens_replaced_by_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_refresh_tokens
    ADD CONSTRAINT child_refresh_tokens_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES private.child_refresh_tokens(id);


--
-- Name: child_refresh_tokens child_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.child_refresh_tokens
    ADD CONSTRAINT child_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.child_sessions(id);


--
-- Name: guardian_invitation_tokens guardian_invitation_tokens_invitation_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.guardian_invitation_tokens
    ADD CONSTRAINT guardian_invitation_tokens_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.guardian_invitations(id);


--
-- Name: parent_pins parent_pins_user_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.parent_pins
    ADD CONSTRAINT parent_pins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: placement_serves placement_serves_campaign_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.placement_serves
    ADD CONSTRAINT placement_serves_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.sponsor_campaigns(id);


--
-- Name: practice_item_keys practice_item_keys_family_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.practice_item_keys
    ADD CONSTRAINT practice_item_keys_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: practice_item_keys practice_item_keys_item_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.practice_item_keys
    ADD CONSTRAINT practice_item_keys_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.practice_items(id);


--
-- Name: push_tokens push_tokens_device_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.push_tokens
    ADD CONSTRAINT push_tokens_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.notification_devices(id);


--
-- Name: question_solutions question_solutions_family_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.question_solutions
    ADD CONSTRAINT question_solutions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: question_solutions question_solutions_question_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.question_solutions
    ADD CONSTRAINT question_solutions_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.extracted_questions(id);


--
-- Name: template_answer_specs template_answer_specs_template_id_fkey; Type: FK CONSTRAINT; Schema: private; Owner: -
--

ALTER TABLE ONLY private.template_answer_specs
    ADD CONSTRAINT template_answer_specs_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.question_templates(id);


--
-- Name: ad_reports ad_reports_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_reports
    ADD CONSTRAINT ad_reports_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.sponsor_campaigns(id);


--
-- Name: ad_reports ad_reports_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_reports
    ADD CONSTRAINT ad_reports_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.resource_catalog(id);


--
-- Name: ad_reports ad_reports_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_reports
    ADD CONSTRAINT ad_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: admin_users admin_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: aggregate_ad_events aggregate_ad_events_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregate_ad_events
    ADD CONSTRAINT aggregate_ad_events_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.sponsor_campaigns(id);


--
-- Name: aggregate_ad_events aggregate_ad_events_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregate_ad_events
    ADD CONSTRAINT aggregate_ad_events_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.resource_catalog(id);


--
-- Name: ai_usage_events ai_usage_events_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: assignments assignments_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: assignments assignments_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: assignments assignments_subject_child_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_subject_child_fkey FOREIGN KEY (subject_id, child_id) REFERENCES public.child_subjects(id, child_id);


--
-- Name: assignments assignments_subject_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_subject_id_family_id_fkey FOREIGN KEY (subject_id, family_id) REFERENCES public.child_subjects(id, family_id);


--
-- Name: attempt_overrides attempt_overrides_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_overrides
    ADD CONSTRAINT attempt_overrides_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES public.attempts(id);


--
-- Name: attempt_overrides attempt_overrides_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_overrides
    ADD CONSTRAINT attempt_overrides_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: attempt_overrides attempt_overrides_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempt_overrides
    ADD CONSTRAINT attempt_overrides_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES auth.users(id);


--
-- Name: attempts attempts_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: attempts attempts_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attempts
    ADD CONSTRAINT attempts_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: audit_events audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);


--
-- Name: audit_events audit_events_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: billing_periods billing_periods_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_periods
    ADD CONSTRAINT billing_periods_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: billing_provider_events billing_provider_events_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_provider_events
    ADD CONSTRAINT billing_provider_events_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: capacity_changes capacity_changes_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_changes
    ADD CONSTRAINT capacity_changes_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: capacity_changes capacity_changes_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_changes
    ADD CONSTRAINT capacity_changes_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id);


--
-- Name: child_devices child_devices_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_devices
    ADD CONSTRAINT child_devices_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_devices child_devices_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_devices
    ADD CONSTRAINT child_devices_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_feedback child_feedback_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_feedback
    ADD CONSTRAINT child_feedback_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_feedback child_feedback_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_feedback
    ADD CONSTRAINT child_feedback_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_feedback child_feedback_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_feedback
    ADD CONSTRAINT child_feedback_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.extracted_questions(id);


--
-- Name: child_profiles child_profiles_attested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_attested_by_fkey FOREIGN KEY (attested_by) REFERENCES auth.users(id);


--
-- Name: child_profiles child_profiles_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_profiles
    ADD CONSTRAINT child_profiles_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_sessions child_sessions_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_sessions
    ADD CONSTRAINT child_sessions_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_sessions child_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_sessions
    ADD CONSTRAINT child_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.child_devices(id);


--
-- Name: child_sessions child_sessions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_sessions
    ADD CONSTRAINT child_sessions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_slot_assignments child_slot_assignments_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_slot_assignments
    ADD CONSTRAINT child_slot_assignments_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_slot_assignments child_slot_assignments_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_slot_assignments
    ADD CONSTRAINT child_slot_assignments_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: child_subjects child_subjects_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_subjects
    ADD CONSTRAINT child_subjects_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: child_subjects child_subjects_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.child_subjects
    ADD CONSTRAINT child_subjects_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: consent_records consent_records_adult_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_adult_user_id_fkey FOREIGN KEY (adult_user_id) REFERENCES auth.users(id);


--
-- Name: consent_records consent_records_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: data_exports data_exports_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: data_exports data_exports_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: data_exports data_exports_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_exports
    ADD CONSTRAINT data_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id);


--
-- Name: deletion_requests deletion_requests_child_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_child_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id) ON DELETE SET NULL (child_id);


--
-- Name: deletion_requests deletion_requests_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: deletion_requests deletion_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id);


--
-- Name: donation_accruals donation_accruals_billing_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_billing_period_id_fkey FOREIGN KEY (billing_period_id) REFERENCES public.billing_periods(id);


--
-- Name: donation_accruals donation_accruals_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: donation_accruals donation_accruals_payout_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_payout_batch_id_fkey FOREIGN KEY (payout_batch_id) REFERENCES public.donation_payout_batches(id);


--
-- Name: donation_accruals donation_accruals_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_accruals
    ADD CONSTRAINT donation_accruals_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: donation_adjustments donation_adjustments_accrual_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_adjustments
    ADD CONSTRAINT donation_adjustments_accrual_id_fkey FOREIGN KEY (accrual_id) REFERENCES public.donation_accruals(id);


--
-- Name: donation_adjustments donation_adjustments_payout_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_adjustments
    ADD CONSTRAINT donation_adjustments_payout_batch_id_fkey FOREIGN KEY (payout_batch_id) REFERENCES public.donation_payout_batches(id);


--
-- Name: donation_payout_batches donation_payout_batches_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.donation_payout_batches
    ADD CONSTRAINT donation_payout_batches_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: extracted_questions extracted_questions_assignment_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_assignment_id_family_id_fkey FOREIGN KEY (assignment_id, family_id) REFERENCES public.assignments(id, family_id);


--
-- Name: extracted_questions extracted_questions_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: extracted_questions extracted_questions_corrected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES auth.users(id);


--
-- Name: extracted_questions extracted_questions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: extracted_questions extracted_questions_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extracted_questions
    ADD CONSTRAINT extracted_questions_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.source_pages(id);


--
-- Name: families families_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: family_capacity family_capacity_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_capacity
    ADD CONSTRAINT family_capacity_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_entitlements family_entitlements_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_entitlements
    ADD CONSTRAINT family_entitlements_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_memberships family_memberships_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_memberships
    ADD CONSTRAINT family_memberships_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_memberships family_memberships_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_memberships
    ADD CONSTRAINT family_memberships_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id);


--
-- Name: family_memberships family_memberships_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_memberships
    ADD CONSTRAINT family_memberships_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id);


--
-- Name: family_memberships family_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_memberships
    ADD CONSTRAINT family_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: family_monetization_prefs family_monetization_prefs_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_monetization_prefs
    ADD CONSTRAINT family_monetization_prefs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_monetization_prefs family_monetization_prefs_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_monetization_prefs
    ADD CONSTRAINT family_monetization_prefs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: family_school_attributions family_school_attributions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_attributions
    ADD CONSTRAINT family_school_attributions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_school_attributions family_school_attributions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_attributions
    ADD CONSTRAINT family_school_attributions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: family_school_designations family_school_designations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_designations
    ADD CONSTRAINT family_school_designations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: family_school_designations family_school_designations_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_designations
    ADD CONSTRAINT family_school_designations_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: family_school_designations family_school_designations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_school_designations
    ADD CONSTRAINT family_school_designations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: guardian_invitations guardian_invitations_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_invitations
    ADD CONSTRAINT guardian_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id);


--
-- Name: guardian_invitations guardian_invitations_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_invitations
    ADD CONSTRAINT guardian_invitations_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: guardian_invitations guardian_invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardian_invitations
    ADD CONSTRAINT guardian_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id);


--
-- Name: identity_declarations identity_declarations_adult_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_declarations
    ADD CONSTRAINT identity_declarations_adult_user_id_fkey FOREIGN KEY (adult_user_id) REFERENCES auth.users(id);


--
-- Name: identity_declarations identity_declarations_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_declarations
    ADD CONSTRAINT identity_declarations_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;


--
-- Name: identity_verifications identity_verifications_adult_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_verifications
    ADD CONSTRAINT identity_verifications_adult_user_id_fkey FOREIGN KEY (adult_user_id) REFERENCES auth.users(id);


--
-- Name: identity_verifications identity_verifications_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_verifications
    ADD CONSTRAINT identity_verifications_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: learning_schedules learning_schedules_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_schedules
    ADD CONSTRAINT learning_schedules_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: learning_schedules learning_schedules_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_schedules
    ADD CONSTRAINT learning_schedules_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: monetization_approvals monetization_approvals_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monetization_approvals
    ADD CONSTRAINT monetization_approvals_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users(id);


--
-- Name: monetization_switches monetization_switches_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monetization_switches
    ADD CONSTRAINT monetization_switches_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);


--
-- Name: notification_deliveries notification_deliveries_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.notification_devices(id);


--
-- Name: notification_deliveries notification_deliveries_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: notification_devices notification_devices_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_devices
    ADD CONSTRAINT notification_devices_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: notification_devices notification_devices_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_devices
    ADD CONSTRAINT notification_devices_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: notification_devices notification_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_devices
    ADD CONSTRAINT notification_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: ops_settings ops_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_settings
    ADD CONSTRAINT ops_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: pending_refunds pending_refunds_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_refunds
    ADD CONSTRAINT pending_refunds_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: placement_rules placement_rules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.placement_rules
    ADD CONSTRAINT placement_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: point_balances point_balances_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_balances
    ADD CONSTRAINT point_balances_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: point_balances point_balances_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_balances
    ADD CONSTRAINT point_balances_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: points_ledger points_ledger_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id);


--
-- Name: points_ledger points_ledger_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: points_ledger points_ledger_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: points_ledger points_ledger_redemption_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_ledger
    ADD CONSTRAINT points_ledger_redemption_id_fkey FOREIGN KEY (redemption_id) REFERENCES public.reward_redemptions(id);


--
-- Name: practice_items practice_items_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: practice_items practice_items_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: practice_items practice_items_set_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_set_id_family_id_fkey FOREIGN KEY (set_id, family_id) REFERENCES public.practice_sets(id, family_id);


--
-- Name: practice_items practice_items_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_items
    ADD CONSTRAINT practice_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.question_templates(id);


--
-- Name: practice_sets practice_sets_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_sets
    ADD CONSTRAINT practice_sets_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: practice_sets practice_sets_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.practice_sets
    ADD CONSTRAINT practice_sets_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: promo_benefit_periods promo_benefit_periods_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: promo_benefit_periods promo_benefit_periods_redemption_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_benefit_periods
    ADD CONSTRAINT promo_benefit_periods_redemption_id_fkey FOREIGN KEY (redemption_id) REFERENCES public.promo_redemptions(id);


--
-- Name: promo_campaign_templates promo_campaign_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaign_templates
    ADD CONSTRAINT promo_campaign_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: promo_campaign_templates promo_campaign_templates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaign_templates
    ADD CONSTRAINT promo_campaign_templates_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: promo_campaigns promo_campaigns_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaigns
    ADD CONSTRAINT promo_campaigns_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: promo_campaigns promo_campaigns_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_campaigns
    ADD CONSTRAINT promo_campaigns_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.promo_campaign_templates(id);


--
-- Name: promo_codes promo_codes_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.promo_campaigns(id);


--
-- Name: promo_redemptions promo_redemptions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.promo_campaigns(id);


--
-- Name: promo_redemptions promo_redemptions_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_code_id_fkey FOREIGN KEY (code_id) REFERENCES public.promo_codes(id);


--
-- Name: promo_redemptions promo_redemptions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: promo_redemptions promo_redemptions_redeemed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_redeemed_by_fkey FOREIGN KEY (redeemed_by) REFERENCES auth.users(id);


--
-- Name: provider_offer_mappings provider_offer_mappings_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_offer_mappings
    ADD CONSTRAINT provider_offer_mappings_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.promo_campaigns(id);


--
-- Name: question_results question_results_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_results
    ADD CONSTRAINT question_results_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: question_results question_results_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_results
    ADD CONSTRAINT question_results_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: question_results question_results_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_results
    ADD CONSTRAINT question_results_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES auth.users(id);


--
-- Name: question_results question_results_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_results
    ADD CONSTRAINT question_results_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.extracted_questions(id);


--
-- Name: resource_catalog resource_catalog_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_catalog
    ADD CONSTRAINT resource_catalog_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: resource_catalog resource_catalog_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_catalog
    ADD CONSTRAINT resource_catalog_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: revenue_adjustments revenue_adjustments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_adjustments
    ADD CONSTRAINT revenue_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: revenue_adjustments revenue_adjustments_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_adjustments
    ADD CONSTRAINT revenue_adjustments_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.revenue_entries(id);


--
-- Name: revenue_entries revenue_entries_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.sponsor_campaigns(id);


--
-- Name: revenue_entries revenue_entries_import_id_source_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_import_id_source_fkey FOREIGN KEY (import_id, source) REFERENCES public.revenue_imports(id, source);


--
-- Name: revenue_imports revenue_imports_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_imports
    ADD CONSTRAINT revenue_imports_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id);


--
-- Name: reward_redemptions reward_redemptions_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_redemptions
    ADD CONSTRAINT reward_redemptions_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: reward_redemptions reward_redemptions_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_redemptions
    ADD CONSTRAINT reward_redemptions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth.users(id);


--
-- Name: reward_redemptions reward_redemptions_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_redemptions
    ADD CONSTRAINT reward_redemptions_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: reward_redemptions reward_redemptions_reward_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_redemptions
    ADD CONSTRAINT reward_redemptions_reward_id_fkey FOREIGN KEY (reward_id) REFERENCES public.rewards(id);


--
-- Name: reward_rules reward_rules_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_rules
    ADD CONSTRAINT reward_rules_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: rewards rewards_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards
    ADD CONSTRAINT rewards_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: rewards rewards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards
    ADD CONSTRAINT rewards_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: rewards rewards_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards
    ADD CONSTRAINT rewards_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: safety_reports safety_reports_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: safety_reports safety_reports_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: safety_reports safety_reports_feedback_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.child_feedback(id) ON DELETE SET NULL;


--
-- Name: safety_reports safety_reports_parent_action_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_parent_action_by_fkey FOREIGN KEY (parent_action_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: safety_reports safety_reports_question_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_question_id_fkey FOREIGN KEY (question_id) REFERENCES public.extracted_questions(id);


--
-- Name: school_admins school_admins_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admins
    ADD CONSTRAINT school_admins_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: school_admins school_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admins
    ADD CONSTRAINT school_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: school_referral_codes school_referral_codes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_referral_codes
    ADD CONSTRAINT school_referral_codes_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: source_pages source_pages_assignment_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_assignment_id_family_id_fkey FOREIGN KEY (assignment_id, family_id) REFERENCES public.assignments(id, family_id);


--
-- Name: source_pages source_pages_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: source_pages source_pages_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_pages
    ADD CONSTRAINT source_pages_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: spend_budgets spend_budgets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spend_budgets
    ADD CONSTRAINT spend_budgets_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: sponsor_campaigns sponsor_campaigns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_campaigns
    ADD CONSTRAINT sponsor_campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: sponsor_campaigns sponsor_campaigns_creative_id_sponsor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_campaigns
    ADD CONSTRAINT sponsor_campaigns_creative_id_sponsor_id_fkey FOREIGN KEY (creative_id, sponsor_id) REFERENCES public.sponsor_creatives(id, sponsor_id);


--
-- Name: sponsor_campaigns sponsor_campaigns_sponsor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_campaigns
    ADD CONSTRAINT sponsor_campaigns_sponsor_id_fkey FOREIGN KEY (sponsor_id) REFERENCES public.sponsors(id);


--
-- Name: sponsor_creatives sponsor_creatives_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: sponsor_creatives sponsor_creatives_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: sponsor_creatives sponsor_creatives_sponsor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsor_creatives
    ADD CONSTRAINT sponsor_creatives_sponsor_id_fkey FOREIGN KEY (sponsor_id) REFERENCES public.sponsors(id);


--
-- Name: sponsors sponsors_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sponsors
    ADD CONSTRAINT sponsors_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: study_materials study_materials_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: study_materials study_materials_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: study_materials study_materials_subject_child_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_subject_child_fkey FOREIGN KEY (subject_id, child_id) REFERENCES public.child_subjects(id, child_id);


--
-- Name: study_materials study_materials_subject_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_materials
    ADD CONSTRAINT study_materials_subject_id_family_id_fkey FOREIGN KEY (subject_id, family_id) REFERENCES public.child_subjects(id, family_id);


--
-- Name: support_case_messages support_case_messages_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_messages
    ADD CONSTRAINT support_case_messages_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id);


--
-- Name: support_case_messages support_case_messages_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_messages
    ADD CONSTRAINT support_case_messages_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.support_cases(id) ON DELETE CASCADE;


--
-- Name: support_cases support_cases_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: support_cases support_cases_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: support_cases support_cases_opened_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_opened_by_user_id_fkey FOREIGN KEY (opened_by_user_id) REFERENCES auth.users(id);


--
-- Name: support_cases support_cases_period_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_period_fkey FOREIGN KEY (channel, provider_period_id) REFERENCES public.billing_periods(channel, provider_period_id) ON DELETE SET NULL;


--
-- Name: target_answer_attempts target_answer_attempts_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.target_answer_attempts
    ADD CONSTRAINT target_answer_attempts_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: target_answer_attempts target_answer_attempts_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.target_answer_attempts
    ADD CONSTRAINT target_answer_attempts_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: test_dates test_dates_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: test_dates test_dates_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: test_dates test_dates_subject_child_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_subject_child_fkey FOREIGN KEY (subject_id, child_id) REFERENCES public.child_subjects(id, child_id);


--
-- Name: test_dates test_dates_subject_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_dates
    ADD CONSTRAINT test_dates_subject_id_family_id_fkey FOREIGN KEY (subject_id, family_id) REFERENCES public.child_subjects(id, family_id);


--
-- Name: usage_reservations usage_reservations_child_id_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_child_id_family_id_fkey FOREIGN KEY (child_id, family_id) REFERENCES public.child_profiles(id, family_id);


--
-- Name: usage_reservations usage_reservations_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_reservations
    ADD CONSTRAINT usage_reservations_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id);


--
-- Name: donation_accruals accruals_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accruals_member_read ON public.donation_accruals FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: ad_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ad_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: donation_adjustments adjustments_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY adjustments_admin_read ON public.donation_adjustments FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users admin_users_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_users_self_read ON public.admin_users FOR SELECT TO authenticated USING ((user_id = app.current_user_id()));


--
-- Name: aggregate_ad_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aggregate_ad_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage_events ai_usage_events_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_usage_events_admin_read ON public.ai_usage_events FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: assignments assignments_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assignments_child_read ON public.assignments FOR SELECT TO pl_child USING (((child_id = app.current_child_id()) AND (status <> 'deleted'::text)));


--
-- Name: assignments assignments_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assignments_member_read ON public.assignments FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: attempt_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attempt_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: attempt_overrides attempt_overrides_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attempt_overrides_member_read ON public.attempt_overrides FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: attempts attempts_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attempts_member_read ON public.attempts FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: family_school_attributions attributions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY attributions_member_read ON public.family_school_attributions FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events audit_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_member_read ON public.audit_events FOR SELECT TO authenticated USING ((((family_id IS NOT NULL) AND app.is_family_member(family_id)) OR app.is_owner_admin()));


--
-- Name: promo_benefit_periods benefit_periods_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY benefit_periods_member_read ON public.promo_benefit_periods FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: billing_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_periods billing_periods_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_periods_member_read ON public.billing_periods FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: billing_provider_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_provider_events ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_provider_events billing_provider_events_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_provider_events_admin_read ON public.billing_provider_events FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: promo_campaigns campaigns_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY campaigns_admin_read ON public.promo_campaigns FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: capacity_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capacity_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: capacity_changes capacity_changes_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY capacity_changes_member_read ON public.capacity_changes FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: child_devices child_devices_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_devices_member_read ON public.child_devices FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: child_feedback child_feedback_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_feedback_child_read ON public.child_feedback FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: child_feedback child_feedback_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_feedback_member_read ON public.child_feedback FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: child_profiles child_profiles_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_profiles_child_read ON public.child_profiles FOR SELECT TO pl_child USING ((id = app.current_child_id()));


--
-- Name: child_profiles child_profiles_member_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_profiles_member_insert ON public.child_profiles FOR INSERT TO authenticated WITH CHECK ((app.is_family_member(family_id) AND app.has_recent_adult_unlock() AND (status = 'draft'::text)));


--
-- Name: child_profiles child_profiles_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_profiles_member_read ON public.child_profiles FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_profiles child_profiles_member_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_profiles_member_update ON public.child_profiles FOR UPDATE TO authenticated USING ((app.is_family_member(family_id) AND app.has_recent_adult_unlock())) WITH CHECK (app.is_family_member(family_id));


--
-- Name: child_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: child_sessions child_sessions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_sessions_member_read ON public.child_sessions FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_slot_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_slot_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: child_slot_assignments child_slot_assignments_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_slot_assignments_member_read ON public.child_slot_assignments FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: child_subjects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.child_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: child_subjects child_subjects_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_subjects_child_read ON public.child_subjects FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: child_subjects child_subjects_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY child_subjects_member ON public.child_subjects TO authenticated USING (app.is_family_member(family_id)) WITH CHECK (app.is_family_member(family_id));


--
-- Name: promo_codes codes_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY codes_admin_read ON public.promo_codes FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: consent_records consent_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY consent_member_read ON public.consent_records FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: consent_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

--
-- Name: data_exports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: data_exports data_exports_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_exports_member_read ON public.data_exports FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: deletion_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: deletion_requests deletion_requests_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY deletion_requests_member_read ON public.deletion_requests FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: family_school_designations designations_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY designations_member_read ON public.family_school_designations FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: donation_accruals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.donation_accruals ENABLE ROW LEVEL SECURITY;

--
-- Name: donation_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.donation_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: donation_payout_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.donation_payout_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: extracted_questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.extracted_questions ENABLE ROW LEVEL SECURITY;

--
-- Name: extracted_questions extracted_questions_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY extracted_questions_child_read ON public.extracted_questions FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: extracted_questions extracted_questions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY extracted_questions_member_read ON public.extracted_questions FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: families; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;

--
-- Name: families families_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_child_read ON public.families FOR SELECT TO pl_child USING ((id = app.current_child_family_id()));


--
-- Name: families families_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_member_read ON public.families FOR SELECT TO authenticated USING (app.is_family_member(id));


--
-- Name: families families_member_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_member_update ON public.families FOR UPDATE TO authenticated USING ((app.is_family_member(id) AND app.has_recent_adult_unlock())) WITH CHECK (app.is_family_member(id));


--
-- Name: family_capacity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_capacity ENABLE ROW LEVEL SECURITY;

--
-- Name: family_capacity family_capacity_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY family_capacity_member_read ON public.family_capacity FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: family_entitlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_entitlements ENABLE ROW LEVEL SECURITY;

--
-- Name: family_entitlements family_entitlements_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY family_entitlements_member_read ON public.family_entitlements FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: family_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: family_monetization_prefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_monetization_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: family_monetization_prefs family_monetization_prefs_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY family_monetization_prefs_member_read ON public.family_monetization_prefs FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: family_school_attributions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_school_attributions ENABLE ROW LEVEL SECURITY;

--
-- Name: family_school_designations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_school_designations ENABLE ROW LEVEL SECURITY;

--
-- Name: guardian_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guardian_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_declarations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.identity_declarations ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_declarations identity_declarations_read_own_family; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY identity_declarations_read_own_family ON public.identity_declarations FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: identity_verifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.identity_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: identity_verifications identity_verifications_read_own_family; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY identity_verifications_read_own_family ON public.identity_verifications FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: guardian_invitations invitations_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invitations_member_read ON public.guardian_invitations FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs jobs_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY jobs_admin_read ON public.jobs FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: learning_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.learning_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: learning_schedules learning_schedules_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY learning_schedules_member ON public.learning_schedules TO authenticated USING (app.is_family_member(family_id)) WITH CHECK (app.is_family_member(family_id));


--
-- Name: family_memberships memberships_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_member_read ON public.family_memberships FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: monetization_approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monetization_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: monetization_switches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monetization_switches ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_deliveries notification_deliveries_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_deliveries_member_read ON public.notification_deliveries FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: notification_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_devices notification_devices_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_devices_member_read ON public.notification_devices FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: notification_devices notification_devices_member_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_devices_member_update ON public.notification_devices FOR UPDATE TO authenticated USING (app.is_family_member(family_id)) WITH CHECK (app.is_family_member(family_id));


--
-- Name: provider_offer_mappings offer_mappings_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offer_mappings_admin_read ON public.provider_offer_mappings FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: ops_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ops_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: donation_payout_batches payout_batches_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payout_batches_admin_read ON public.donation_payout_batches FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: pending_refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.placement_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: point_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.point_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: point_balances point_balances_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY point_balances_child_read ON public.point_balances FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: point_balances point_balances_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY point_balances_member_read ON public.point_balances FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: points_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: points_ledger points_ledger_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY points_ledger_child_read ON public.points_ledger FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: points_ledger points_ledger_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY points_ledger_member_read ON public.points_ledger FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: practice_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.practice_items ENABLE ROW LEVEL SECURITY;

--
-- Name: practice_items practice_items_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY practice_items_child_read ON public.practice_items FOR SELECT TO pl_child USING (((child_id = app.current_child_id()) AND (EXISTS ( SELECT 1
   FROM public.practice_sets s
  WHERE ((s.id = practice_items.set_id) AND (s.status = ANY (ARRAY['ready'::text, 'in_progress'::text, 'completed'::text])) AND ((s.release_at IS NULL) OR (s.release_at <= app.child_request_instant())))))));


--
-- Name: practice_items practice_items_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY practice_items_member_read ON public.practice_items FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: practice_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.practice_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: practice_sets practice_sets_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY practice_sets_child_read ON public.practice_sets FOR SELECT TO pl_child USING (((child_id = app.current_child_id()) AND (status = ANY (ARRAY['ready'::text, 'in_progress'::text, 'completed'::text])) AND ((release_at IS NULL) OR (release_at <= app.child_request_instant()))));


--
-- Name: practice_sets practice_sets_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY practice_sets_member_read ON public.practice_sets FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: promo_benefit_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_benefit_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_campaign_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_campaign_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_offer_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_offer_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: question_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.question_results ENABLE ROW LEVEL SECURITY;

--
-- Name: question_results question_results_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY question_results_child_read ON public.question_results FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: question_results question_results_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY question_results_member_read ON public.question_results FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: question_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.question_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: question_templates question_templates_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY question_templates_admin_read ON public.question_templates FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: promo_redemptions redemptions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY redemptions_member_read ON public.promo_redemptions FOR SELECT TO authenticated USING ((app.is_family_member(family_id) OR app.is_owner_admin()));


--
-- Name: school_referral_codes referral_codes_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY referral_codes_admin_read ON public.school_referral_codes FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: resource_catalog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.resource_catalog ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: reward_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: reward_redemptions reward_redemptions_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reward_redemptions_child_read ON public.reward_redemptions FOR SELECT TO pl_child USING ((child_id = app.current_child_id()));


--
-- Name: reward_redemptions reward_redemptions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reward_redemptions_member_read ON public.reward_redemptions FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: reward_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reward_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: reward_rules reward_rules_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reward_rules_child_read ON public.reward_rules FOR SELECT TO pl_child USING ((family_id = app.current_child_family_id()));


--
-- Name: reward_rules reward_rules_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reward_rules_member_read ON public.reward_rules FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: rewards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rewards ENABLE ROW LEVEL SECURITY;

--
-- Name: rewards rewards_child_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rewards_child_read ON public.rewards FOR SELECT TO pl_child USING ((active AND (family_id = app.current_child_family_id()) AND ((child_id IS NULL) OR (child_id = app.current_child_id()))));


--
-- Name: rewards rewards_member_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rewards_member_insert ON public.rewards FOR INSERT TO authenticated WITH CHECK ((app.is_family_member(family_id) AND app.has_recent_adult_unlock() AND (created_by = app.current_user_id())));


--
-- Name: rewards rewards_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rewards_member_read ON public.rewards FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: rewards rewards_member_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rewards_member_update ON public.rewards FOR UPDATE TO authenticated USING ((app.is_family_member(family_id) AND app.has_recent_adult_unlock())) WITH CHECK (app.is_family_member(family_id));


--
-- Name: safety_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.safety_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: safety_reports safety_reports_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY safety_reports_member_read ON public.safety_reports FOR SELECT TO authenticated USING ((app.is_family_member(family_id) AND family_visible));


--
-- Name: safety_reports safety_reports_parent_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY safety_reports_parent_insert ON public.safety_reports FOR INSERT TO authenticated WITH CHECK ((app.is_family_member(family_id) AND (reporter_kind = 'parent'::text)));


--
-- Name: school_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admins school_admins_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY school_admins_self_read ON public.school_admins FOR SELECT TO authenticated USING (((user_id = app.current_user_id()) OR app.is_owner_admin()));


--
-- Name: school_referral_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_referral_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

--
-- Name: schools schools_active_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schools_active_read ON public.schools FOR SELECT TO authenticated USING (((status = 'active'::text) OR app.is_owner_admin() OR app.is_school_admin(id)));


--
-- Name: source_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: source_pages source_pages_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_pages_member_read ON public.source_pages FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: spend_budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spend_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: spend_budgets spend_budgets_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY spend_budgets_admin_read ON public.spend_budgets FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: sponsor_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sponsor_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: sponsor_creatives; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sponsor_creatives ENABLE ROW LEVEL SECURITY;

--
-- Name: sponsors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sponsors ENABLE ROW LEVEL SECURITY;

--
-- Name: store_feature_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_feature_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: store_product_mappings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.store_product_mappings ENABLE ROW LEVEL SECURITY;

--
-- Name: store_product_mappings store_product_mappings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY store_product_mappings_read ON public.store_product_mappings FOR SELECT TO authenticated USING (active);


--
-- Name: study_materials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_materials ENABLE ROW LEVEL SECURITY;

--
-- Name: study_materials study_materials_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY study_materials_member ON public.study_materials TO authenticated USING (app.is_family_member(family_id)) WITH CHECK (app.is_family_member(family_id));


--
-- Name: support_case_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_case_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: support_case_messages support_case_messages_member_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_case_messages_member_insert ON public.support_case_messages FOR INSERT TO authenticated WITH CHECK (((author_kind = 'parent'::text) AND (author_user_id = app.current_user_id()) AND (NOT internal) AND (EXISTS ( SELECT 1
   FROM public.support_cases c
  WHERE ((c.id = support_case_messages.case_id) AND app.is_family_member(c.family_id) AND (c.status <> 'closed'::text))))));


--
-- Name: support_case_messages support_case_messages_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_case_messages_member_read ON public.support_case_messages FOR SELECT TO authenticated USING (((NOT internal) AND (EXISTS ( SELECT 1
   FROM public.support_cases c
  WHERE ((c.id = support_case_messages.case_id) AND app.is_family_member(c.family_id))))));


--
-- Name: support_cases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;

--
-- Name: support_cases support_cases_member_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_cases_member_insert ON public.support_cases FOR INSERT TO authenticated WITH CHECK ((app.is_family_member(family_id) AND (opened_by_kind = 'parent'::text) AND (opened_by_user_id = app.current_user_id()) AND (status = 'open'::text) AND (priority = 'normal'::text) AND (assignee_user_id IS NULL) AND (resolution IS NULL) AND ((provider_period_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.billing_periods p
  WHERE ((p.family_id = support_cases.family_id) AND (p.channel = support_cases.channel) AND (p.provider_period_id = support_cases.provider_period_id)))))));


--
-- Name: support_cases support_cases_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY support_cases_member_read ON public.support_cases FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: target_answer_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.target_answer_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: target_answer_attempts target_answer_attempts_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY target_answer_attempts_member_read ON public.target_answer_attempts FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- Name: promo_campaign_templates templates_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY templates_admin_read ON public.promo_campaign_templates FOR SELECT TO authenticated USING (app.is_owner_admin());


--
-- Name: test_dates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.test_dates ENABLE ROW LEVEL SECURITY;

--
-- Name: test_dates test_dates_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY test_dates_member ON public.test_dates TO authenticated USING (app.is_family_member(family_id)) WITH CHECK (app.is_family_member(family_id));


--
-- Name: usage_reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_reservations usage_reservations_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_reservations_member_read ON public.usage_reservations FOR SELECT TO authenticated USING (app.is_family_member(family_id));


--
-- PostgreSQL database dump complete
--



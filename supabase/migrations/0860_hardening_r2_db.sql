-- 0860_hardening_r2_db.sql
-- Hardening round 2, database findings DB-R2-01..05, 07, 08 and API-AUTH-R2-01/02
-- (docs/Bug_Ledger.md).
--   1. DB-R2-01/02/03/07: eleven hot predicates the jobs and the parent routes run had no index
--      path, so each one scanned every family's rows: the evidence load's per-attempt override
--      probe, the inactivity sweep's three per-family MAX() subqueries, the AI spend admission's
--      month sum (taken while the single global budget row is locked), and the reward-request,
--      test-date, study-material, device and export lists. Each index below names the query it
--      serves.
--   2. DB-R2-04: the Supabase default privileges grant ALL on every new public table to anon,
--      authenticated and service_role. Each migration revoked only insert/update/delete from
--      `authenticated`, so it kept TRUNCATE, TRIGGER and REFERENCES on all ~80 public tables.
--      TRUNCATE ignores RLS and fires no row trigger, so app.prevent_mutation() on audit_events,
--      consent_records, points_ledger and ai_usage_events did not stop it: one SQL-injection bug on
--      a path that runs as `authenticated` could have emptied the audit, consent and ledger
--      evidence of every family. Revoked on every table and in the default privileges.
--   3. DB-R2-05 and API-AUTH-R2-01 (one gap, two reports): rules that existed only in the Hono
--      routes were skipped by a direct PostgREST write with the parent's own JWT. child_profiles
--      and safety_reports are written by the API with the service role, so their direct grants are
--      revoked outright (that is the CHILD_PROFILE_LIMIT cap, the K-8 / under-13 contract and the
--      safety-queue flood, all at once). The learning, reward and support tables ARE written by the
--      API as the parent role (routes/learning.ts, routes/rewards.ts, routes/support.ts), so their
--      grants stay and the rules move into the database as BEFORE triggers: no write for an
--      archived child, none for a child whose deletion is under way, none carrying control
--      characters, and a per-family hourly bound on the tables that grow.
--   4. API-AUTH-R2-02: a backstop trigger refuses a child_profiles status change back to 'active'
--      while a family- or child-scope deletion request for it is requested/processing (the route
--      already refuses it; this holds for every writer, service role included).
--   5. DB-R2-08: private.child_pairing_codes (short-code hashes) and stale private.ai_spend_holds
--      were deleted only by a family or child purge, or never. app.prune_credential_rows(interval)
--      prunes both, and child_pairing_codes gains the (family_id, child_id) index the purge's
--      delete needs. Service-only; wired into the tick by apps/api/src/auth/housekeeping.ts.

-- ---------------------------------------------------------------------------------------------
-- 1. Indexes for the hot per-family, per-child and per-attempt predicates (DB-R2-01/02/03/07)
-- ---------------------------------------------------------------------------------------------

-- DB-R2-01. Serves the evidence load's lateral in apps/api/src/jobs/learning-jobs.ts loadEvidence
-- (`select correctness, created_at from public.attempt_overrides where attempt_id = a.id
--   order by created_at desc limit 1`), run once per attempt in the child's 21-day window before
-- the sort and the 5 000-row limit, for every daily_set_generate and thursday_review_generate job.
-- Also the referencing side of attempt_overrides_attempt_id_fkey, so the purge's
-- `delete from public.attempts` no longer scans the overrides once per deleted attempt.
create index attempt_overrides_attempt on public.attempt_overrides (attempt_id, created_at desc);

-- DB-R2-02. Serve the three per-family MAX() subqueries of `lastActive`
-- (apps/api/src/jobs/dispatcher.ts inactivitySweep: the notice-void UPDATE and the candidate
-- SELECT) and the identical subqueries inside app.inactivity_delete_family (0840). PG16 runs each
-- as a SubPlan per family, so without these the sweep costs families x (assignments + attempts).
create index assignments_family_created on public.assignments (family_id, created_at desc);
create index attempts_family_created on public.attempts (family_id, created_at desc);
create index family_memberships_family on public.family_memberships (family_id);

-- DB-R2-03. Serves the AI spend admission's month sum in apps/api/src/jobs/spend-ceiling.ts
-- (`select sum(cost_micros) from public.ai_usage_events where created_at >= monthStart`), taken
-- while the single global spend_budgets row is held `for update`, and the same sum in the
-- dispatcher's alert pass and ops-metrics.ts. cost_micros is included so the sum is an index-only
-- scan. ai_usage_events_family (family_id, created_at desc) cannot seek on a created_at range.
create index ai_usage_events_created on public.ai_usage_events (created_at) include (cost_micros);

-- DB-R2-07. One index per remaining per-request list, each also serving the family/child purge:
--   apps/api/src/routes/rewards.ts parent overview (family_id = .. and state in (..))
create index reward_redemptions_family_state
  on public.reward_redemptions (family_id, state, requested_at);
--   apps/api/src/routes/learning.ts test-date list and schedule response, and
--   apps/api/src/jobs/learning-jobs.ts loadTestDates (child_id = .. [and test_date between ..])
create index test_dates_child on public.test_dates (child_id, test_date);
--   apps/api/src/jobs/learning-jobs.ts material selection, run for every practice job
--   (child_id = .. and created_at >= ..); rows hold up to 20 KB of text
create index study_materials_child_created on public.study_materials (child_id, created_at desc);
--   apps/api/src/routes/family.ts GET /devices (family_id = .. order by paired_at desc)
create index child_devices_family on public.child_devices (family_id, paired_at desc);
--   apps/api/src/routes/privacy.ts GET /exports (family_id = .. order by created_at desc)
create index data_exports_family on public.data_exports (family_id, created_at desc);

-- The per-family hourly bounds in section 3 count a family's rows of the last hour, and the family
-- purge deletes these tables by family_id; neither had an index leading with family_id.
create index child_subjects_family_created on public.child_subjects (family_id, created_at desc);
create index test_dates_family_created on public.test_dates (family_id, created_at desc);
create index study_materials_family_created on public.study_materials (family_id, created_at desc);
create index rewards_family_created on public.rewards (family_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- 2. TRUNCATE, TRIGGER and REFERENCES are not client privileges (DB-R2-04)
-- ---------------------------------------------------------------------------------------------

-- PostgREST never exposes TRUNCATE, but any SQL that runs as `authenticated` could: the API opens
-- its parent transactions with `set local role authenticated` on a direct connection. TRUNCATE
-- bypasses RLS and fires no row trigger, so it was the one write app.prevent_mutation() could not
-- see. TRIGGER and REFERENCES are equally not client privileges (a client could attach its own
-- trigger function to a family table, or key its own table to one and change delete behaviour).
revoke truncate, trigger, references on all tables in schema public
  from anon, authenticated, pl_child;

-- New tables must not receive them again. The default privileges are per granting role, so this
-- cancels the entry the platform shim (and, on the hosted project, the `postgres` role) created;
-- supabase/tests/schema_invariants.test.ts fails on any public table where a client role holds one
-- of the three, so a hosted default privilege set by another role is caught in CI.
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The Data API is held to the API's rules (DB-R2-05, API-AUTH-R2-01)
-- ---------------------------------------------------------------------------------------------

-- 3a. Tables the API writes with the service role keep no parent write grant at all.

-- apps/api/src/routes/family.ts creates, edits, activates and archives a child profile with
-- asService (the 12-profile cap takes the family row lock and counts, the request body is parsed by
-- createChildProfileRequestSchema, which is the K-8 / under-13 contract). The direct grant was the
-- only way to add a 13th profile, to store grade 12 / age band 14-18 — which makes the portal's own
-- familyOverviewResponseSchema reject the whole family page — or to store control characters.
revoke insert, update on public.child_profiles from authenticated;

-- apps/api/src/routes/privacy.ts POST /safety-reports inserts with asService (it must set child_id,
-- which the grant never covered) after checking the family, the question and the child. The direct
-- grant let one parent write 500 reports in one statement into the owner's safety queue.
revoke insert on public.safety_reports from authenticated;

-- The RLS policies child_profiles_member_insert / _member_update and safety_reports_parent_insert
-- stay in place: they are the second layer if a column grant is ever restored.

-- 3b. Tables the API writes as the parent role keep their grants; the rules become triggers.

-- True when `p_text` holds a control character other than tab, line feed or carriage return: the
-- same rule as freeTextSchema in packages/contracts/src/common.ts (L-028), which is `\p{Cc}` =
-- U+0000..U+001F and U+007F..U+009F. U+0000 cannot be stored in a text column at all.
create or replace function app.text_has_control_character(p_text text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_text ~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]', false)
$$;

-- Refuses a parent write for a child the API would refuse. Same rules as ownedChild() in
-- apps/api/src/routes/learning.ts and the archived/deletion checks in routes/rewards.ts:
--   * the child must belong to the caller's family (RLS already checks this; re-checked here so
--     this function cannot be used to probe another family's children);
--   * an archived profile is history only (CHILD_ARCHIVED);
--   * a child covered by an open deletion request is gone as far as writes go (spec P4 stops
--     processing at the request), whether the request names the child or the whole family.
-- SECURITY DEFINER so the checks read the authoritative rows, not what RLS shows the caller.
create or replace function app.assert_parent_child_write(p_family uuid, p_child uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
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

-- Executable by `authenticated`: the guard triggers below run with the caller's own privileges (so
-- they can tell the Data API apart from the service role), and call this for the checks that need
-- to read past RLS. It answers only about the caller's own family.
revoke execute on function app.assert_parent_child_write(uuid, uuid) from public, anon, pl_child;
grant execute on function app.assert_parent_child_write(uuid, uuid) to authenticated, service_role;

/*
  Per-family hourly bounds. The API's own rules (apps/api/src/middleware/rate-limit.ts RATE_RULES
  and the local rules in routes/support.ts) count REQUESTS in a fixed window; these count ROWS of
  the family in the sliding hour before the write, so each bound is twice the API's rule: the API's
  fixed window can legitimately allow one whole rule's worth at the end of one window and another at
  the start of the next. The database's job here is not to replace the API limiter but to stop a
  single Data-API statement writing hundreds of rows (the reported floods were 200 study materials
  of 20 000 characters and 500 support cases in one request each). A bound must never be stricter
  than the API's rule, so it counts only rows a limited API request creates: rows written by an
  unlimited path (the lazily created default subjects of ensureLearningDefaults) and statements that
  create no row (an UPDATE) are outside every count. Each branch below states its own rule.

  learning_schedules has no bound: it holds exactly one row per child (child_id is its primary key),
  so an update flood stores nothing. rewards updates are likewise bounded by the row count.
*/

create or replace function app.data_api_learning_write_guard() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger child_subjects_data_api_guard
  before insert or update on public.child_subjects
  for each row execute function app.data_api_learning_write_guard();
create trigger test_dates_data_api_guard
  before insert on public.test_dates
  for each row execute function app.data_api_learning_write_guard();
create trigger study_materials_data_api_guard
  before insert on public.study_materials
  for each row execute function app.data_api_learning_write_guard();
create trigger learning_schedules_data_api_guard
  before insert or update on public.learning_schedules
  for each row execute function app.data_api_learning_write_guard();

-- Rewards. The insert policy already requires app.has_recent_adult_unlock() (0400), which is what
-- routes/rewards.ts requires too; what it did not check is the archived child, the child under
-- deletion and the free text. child_id is nullable (a reward offered to every child in the family).
create or replace function app.data_api_reward_write_guard() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger rewards_data_api_guard
  before insert or update on public.rewards
  for each row execute function app.data_api_reward_write_guard();

-- Support cases and their messages (0810). routes/support.ts inserts both as the parent role, one
-- row per request, behind its own per-family limits (10 cases and 30 replies an hour). Only parent
-- rows are bounded: a staff reply is written with the service role (routes/admin-ops.ts) and must
-- never be refused because a family used up its own budget.
create or replace function app.data_api_support_write_guard() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger support_cases_data_api_guard
  before insert on public.support_cases
  for each row execute function app.data_api_support_write_guard();
create trigger support_case_messages_data_api_guard
  before insert on public.support_case_messages
  for each row execute function app.data_api_support_write_guard();

-- ---------------------------------------------------------------------------------------------
-- 4. A child under deletion is never activated again (API-AUTH-R2-02)
-- ---------------------------------------------------------------------------------------------

-- routes/family.ts already refuses this (visibleChild() hides a child under deletion and a
-- tombstoned family), but activation grants a paid slot and re-opens practice, and the purge that
-- follows would then delete the re-activated profile and everything added since without warning.
-- This runs for every writer, the service role included: it is the backstop, not a Data-API rule.
create or replace function app.child_profiles_no_activation_under_deletion() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger child_profiles_no_activation_under_deletion
  before update on public.child_profiles
  for each row execute function app.child_profiles_no_activation_under_deletion();

-- ---------------------------------------------------------------------------------------------
-- 5. Pairing codes and expired spend holds are pruned (DB-R2-08)
-- ---------------------------------------------------------------------------------------------

-- Serves the family and child purges' `delete from private.child_pairing_codes where family_id = ..
-- [and child_id = any(..)]` (app.purge_family_data, 0620/0710/0820) and the pruning below. The
-- table had only its primary key, the code_hash unique index and the partial live-per-child index.
create index child_pairing_codes_family_child
  on private.child_pairing_codes (family_id, child_id);

-- Retention for the credential-derived and bookkeeping rows nothing else cleaned up (twin of
-- BUG-155 / DB-R1-07). Deletes:
--   * pairing codes that stopped being usable more than p_older_than ago. A code stops at the
--     earlier of its expiry and the moment it was consumed; a code that can still be redeemed is
--     kept whatever its age, and so is a recently dead one (a redemption attempt on a just-expired
--     code must still find it, so the API answers "expired" rather than "unknown");
--   * spend holds whose expiry passed more than a day ago: a worker that died left them, the
--     admission sum (`where expires_at > now`) already ignores them, and spend-ceiling.ts only ever
--     deletes a hold by id. A day is well past the longest stage timeout, so a hold that is still
--     doing its job is never touched.
-- Aged by the database clock, the clock these columns are written and compared with. Returns the
-- number of rows deleted across the two tables. Service-only (L-002); wired into the scheduled tick
-- by apps/api/src/auth/housekeeping.ts.
create or replace function app.prune_credential_rows(p_older_than interval)
returns integer
language plpgsql security definer
set search_path = ''
as $$
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

revoke execute on function app.prune_credential_rows(interval)
  from public, anon, authenticated, pl_child;
grant execute on function app.prune_credential_rows(interval) to service_role;

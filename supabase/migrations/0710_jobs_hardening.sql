-- 0710_jobs_hardening.sql
-- Jobs, deletion and retention hardening from the lead jobs/AI review (RV-lead-jobs-ai-2..20).
-- Depends on 0100, 0200, 0600, 0620 (purge flag and purge function), 0680 (inactivity).
--
-- 1. source_pages.storage_removed_at: raw-file retention tracks "the object is gone from storage"
--    separately from the row's soft deletion, so a failed storage delete is always retried (RV-5).
--    assignments.uploads_closed_at records when a scan stopped accepting uploads. A signed upload URL
--    is honoured for up to two hours, so a removal is final only once the upload window
--    (app.late_upload_window(), 3 hours) has passed since uploads closed. Marking a page removed
--    earlier schedules a second storage pass automatically, whoever marks it (checker follow-up).
-- 2. private.storage_removals: second storage passes, for objects a still-valid signed upload writes
--    after a removal or after the purge removed the rows (RV-5, RV-20). Paths only; rows are
--    deleted once storage confirms the removal.
-- 3. private.sweep_runs: once-per-UTC-day markers, so the daily inactivity sweep does not depend on a
--    cron tick landing in one five-minute window.
-- 4. private.ai_spend_holds: in-flight AI stage estimates counted against the owner's monthly ceiling
--    by concurrent workers (RV-10). A hold expires with the job lease if its worker dies.
-- 5. Usage reservations and AI usage events survive a child purge with the child pseudonymised
--    (child_id null): they are quota and cost records, and deleting them handed the family a fresh
--    monthly allowance (RV-17, RV-18). A usage event metered after (or racing) the purge of its child
--    is stored without the child: the insert waits for a running purge of the family, then drops a
--    child id that no longer exists.
-- 6. request_deletion and inactivity deletion move the family's or child's assignments to 'deleted'
--    in the tombstone transaction, so a running scan's next compare-and-set fails (RV-3).
-- 7. Inactivity deletion re-checks idleness, the notice and a paid subscription under the family row
--    lock and returns null (skip) instead of raising (RV-12, RV-13, RV-15). "Paid" is one rule,
--    app.family_may_be_charged: a store still retrying payment (grace period, billing retry) or an
--    auto-renewing subscription whose renewal is not reported yet counts, whatever period_end says.
-- 8. purge_family_data also purges the family's/child's queue rows, keeps usage reservations,
--    pseudonymises AI usage events and removes family-wide exports on a child purge (RV-17, RV-18).
--
-- Retained after a purge (explicitly justified, extends 0620's list): usage_reservations (per-period
-- allowance ledger; child_id nulled) and ai_usage_events (owner cost records; child_id nulled). The
-- deletion_purge jobs themselves stay (payload: the deletion request id only).

-- ---------------------------------------------------------------------------------------------
-- 1. Raw-file retention
-- ---------------------------------------------------------------------------------------------

alter table public.source_pages add column storage_removed_at timestamptz;
create index source_pages_storage_pending on public.source_pages (created_at)
  where storage_removed_at is null;

-- Upload URLs are signed only while a scan is 'draft' or 'uploading'. The moment it leaves those
-- states is the last moment a new URL can be issued; null while uploads are open. Assignments that
-- closed before this migration have no value and fall back to updated_at (an upper bound).
alter table public.assignments add column uploads_closed_at timestamptz;

create or replace function app.stamp_uploads_closed() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger assignments_uploads_closed before insert or update of status on public.assignments
  for each row execute function app.stamp_uploads_closed();

-- Signed upload URLs are honoured for two hours (Supabase fixes the lifetime server-side); one more
-- hour covers an upload still in flight. Must equal LATE_UPLOAD_WINDOW_MS in apps/api (tested).
create or replace function app.late_upload_window() returns interval
language sql immutable
set search_path = ''
as $$ select interval '3 hours' $$;

-- True while a signed upload URL for the scan's pages may still be honoured: uploads are open, or
-- they closed less than the upload window ago (database clock on both sides).
create or replace function app.upload_window_open(p_assignment uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select a.status in ('draft', 'uploading')
        or coalesce(a.uploads_closed_at, a.updated_at) > now() - app.late_upload_window()
      from public.assignments a
     where a.id = p_assignment), false)
$$;

revoke execute on function app.late_upload_window(), app.upload_window_open(uuid)
  from public, anon, authenticated, pl_child;
grant execute on function app.late_upload_window(), app.upload_window_open(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2-4. Private operational tables (service role only; no client role has privileges in private)
-- ---------------------------------------------------------------------------------------------

create table private.storage_removals (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null check (char_length(storage_path) between 1 and 1024),
  remove_after timestamptz not null,
  reason text not null check (reason in ('deletion_late_upload', 'removal_late_upload')),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now()
);
create index storage_removals_due on private.storage_removals (remove_after);

create table private.sweep_runs (
  sweep text not null check (sweep in ('inactivity')),
  run_key text not null check (run_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  started_at timestamptz not null,
  primary key (sweep, run_key)
);

create table private.ai_spend_holds (
  id uuid primary key default gen_random_uuid(),
  period_key text not null check (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
  micros bigint not null check (micros > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index ai_spend_holds_period on private.ai_spend_holds (period_key, expires_at);

revoke all on private.storage_removals, private.sweep_runs, private.ai_spend_holds
  from public, anon, authenticated, pl_child;
grant all on private.storage_removals, private.sweep_runs, private.ai_spend_holds to service_role;

-- A page marked removed while its upload window is open may be written again by a still-valid
-- signed URL (cancel route, retention sweep, any later writer): its second pass is scheduled in the
-- same transaction, due one window after the removal (the removal is never earlier than the close).
create or replace function app.schedule_late_page_removal() returns trigger
language plpgsql security definer
set search_path = ''
as $$
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

create trigger source_pages_late_removal after update of storage_removed_at on public.source_pages
  for each row execute function app.schedule_late_page_removal();

-- ---------------------------------------------------------------------------------------------
-- 5. Quota and cost records outlive the child they were charged to (pseudonymised)
-- ---------------------------------------------------------------------------------------------

alter table public.usage_reservations alter column child_id drop not null;

-- Terminal usage states cannot change; facts are immutable. The single exception: a purge may
-- pseudonymise the child (child_id -> null). New reservations always name their child.
create or replace function app.guard_usage_transition() returns trigger
language plpgsql
set search_path = ''
as $$
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

drop trigger usage_reservations_transition on public.usage_reservations;
create trigger usage_reservations_transition before insert or update on public.usage_reservations
  for each row execute function app.guard_usage_transition();

-- AI usage events are append-only; only a running purge may null the child id (nothing else).
create or replace function app.guard_ai_usage_event() returns trigger
language plpgsql
set search_path = ''
as $$
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

drop trigger ai_usage_events_append_only on public.ai_usage_events;
create trigger ai_usage_events_append_only before update or delete on public.ai_usage_events
  for each row execute function app.guard_ai_usage_event();

-- A stage can return after another worker purged its child (overlapping ticks): its usage row must
-- not bring the purged child's id back. The family row lock serialises with a running purge
-- (purge_family_data holds it FOR UPDATE until commit); only then is the child's existence read, so
-- a purged child is dropped and the cost is kept. A purge that starts later sees this row.
create or replace function app.pseudonymise_late_usage() returns trigger
language plpgsql security definer
set search_path = ''
as $$
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

create trigger ai_usage_events_child before insert on public.ai_usage_events
  for each row execute function app.pseudonymise_late_usage();

-- ---------------------------------------------------------------------------------------------
-- 6. Deletion requests stop in-flight processing
-- ---------------------------------------------------------------------------------------------

create or replace function public.request_deletion(p_family uuid, p_child uuid default null)
returns public.deletion_requests
language plpgsql security definer
set search_path = ''
as $$
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
  update public.assignments set status = 'deleted'
   where family_id = p_family and status <> 'deleted' and (p_child is null or child_id = p_child);
  if p_child is null then
    update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
  else
    update public.child_profiles set status = 'archived', archived_at = now() where id = p_child;
  end if;

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

revoke execute on function public.request_deletion(uuid, uuid) from public, anon, pl_child;
grant execute on function public.request_deletion(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Inactivity deletion: every precondition re-checked under the family row lock
-- ---------------------------------------------------------------------------------------------

-- The one-argument version trusted the caller's stale view (a notice cleared or answered by activity
-- after the candidate query) and raised on a returning parent, aborting the scheduled tick.
drop function app.inactivity_delete_family(uuid);

-- True while a store may still charge the family: any entitlement that is not over. A current
-- period; a store still retrying payment (grace period, billing retry: the charge can still succeed);
-- or an auto-renewing subscription past period_end whose renewal has not been reported yet (a lost
-- webhook; the entitlement safety net re-fetches it). Expired, revoked and refunded never charge.
create or replace function app.family_may_be_charged(p_family uuid, p_now timestamptz)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.family_entitlements e
     where e.family_id = p_family
       and e.status not in ('expired', 'revoked', 'refunded')
       and (e.period_end is null or e.period_end > p_now
            or e.status in ('grace_period', 'billing_retry')
            or e.auto_renew))
$$;

revoke execute on function app.family_may_be_charged(uuid, timestamptz)
  from public, anon, authenticated, pl_child;
grant execute on function app.family_may_be_charged(uuid, timestamptz) to service_role;

-- Returns the deletion request id, or null when the family must not be deleted now: already gone,
-- no notice, activity since the notice (or not idle), the notice period not over, or an active paid
-- subscription. The instants come from the API clock (domain code takes `now` as input).
create or replace function app.inactivity_delete_family(
  p_family uuid, p_now timestamptz, p_idle_before timestamptz, p_notice_before timestamptz)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
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
  insert into public.jobs (kind, idempotency_key, family_id, payload)
    values ('deletion_purge', 'deletion:' || req.id::text, p_family,
            jsonb_build_object('deletionRequestId', req.id, 'reason', 'inactivity'));
  insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
    values (p_family, 'system', 'deletion.inactivity', 'family', p_family::text);
  return req.id;
end
$$;

revoke execute on function app.inactivity_delete_family(uuid, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, pl_child;
grant execute on function app.inactivity_delete_family(uuid, timestamptz, timestamptz, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. Purge: queue rows, quota/cost records and family-wide exports
-- ---------------------------------------------------------------------------------------------

create or replace function app.purge_family_data(p_family uuid, p_child uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
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

revoke execute on function app.purge_family_data(uuid, uuid) from public, anon, authenticated, pl_child;
grant execute on function app.purge_family_data(uuid, uuid) to service_role;

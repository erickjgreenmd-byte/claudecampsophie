-- 0620_deletion_purge.sql
-- Active-store deletion for tombstoned families and deleted children (spec P4, E4 Deletion,
-- AC_ACCESS_10, AC_SECURITY_05). Append-only guards normally forbid deletes; the purge function
-- lifts them only inside its own transaction (transaction-local setting) and only for a family that
-- is already tombstoned or a child with an open deletion request.
--
-- Retained (explicitly justified, separate access): billing periods, entitlements, provider events,
-- promo redemptions/benefits and the donation ledger (financial records); consent records (legal
-- evidence of consent/withdrawal); audit events (pseudonymous ids only). The family row stays as a
-- tombstone so late provider events can be recognised and ignored instead of recreating data.

-- True only while app.purge_family_data runs: the flag must be set AND the statement must execute
-- with the function owner's privileges (a client role that sets the flag itself is still refused).
create or replace function app.purge_in_progress() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('pencillift.purging', true), '') = 'on'
     and current_user not in ('anon', 'authenticated', 'pl_child', 'service_role')
$$;

-- Append-only / no-delete guards: deletes are allowed only while a purge runs.
create or replace function app.prevent_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and app.purge_in_progress() then
    return old;
  end if;
  raise exception 'table %.% is append-only; record an adjustment instead', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

create or replace function app.guard_reward_redemption() returns trigger
language plpgsql
set search_path = ''
as $$
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

-- A deletion request outlives the child it deletes: keep the request (and the child's pseudonymous id in
-- its purge report and the audit log) while the child row itself is removed.
alter table public.deletion_requests drop constraint deletion_requests_child_id_family_id_fkey;
alter table public.deletion_requests
  add constraint deletion_requests_child_fkey foreign key (child_id, family_id)
  references public.child_profiles (id, family_id) on delete set null (child_id);
alter table public.deletion_requests drop constraint deletion_requests_check;
alter table public.deletion_requests add column target_child_id uuid;
update public.deletion_requests set target_child_id = child_id where child_id is not null;
alter table public.deletion_requests
  add constraint deletion_requests_scope_target_check check ((scope = 'child') = (target_child_id is not null));
drop index public.deletion_requests_one_open;
create unique index deletion_requests_one_open
  on public.deletion_requests (family_id, coalesce(target_child_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('requested', 'processing');

-- request_deletion (0600) now also records the durable target child id and enqueues the purge job.
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

create or replace function app.purge_family_data(p_family uuid, p_child uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  fam public.families;
  children uuid[];
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
  delete from public.usage_reservations where family_id = p_family and child_id = any(children);
  delete from public.assignments where family_id = p_family and child_id = any(children);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('assignments', n);

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
  delete from public.data_exports where family_id = p_family and (child_id = any(children) or p_child is null);

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
revoke execute on function app.purge_in_progress() from public, anon;
grant execute on function app.purge_in_progress() to authenticated, service_role, pl_child;

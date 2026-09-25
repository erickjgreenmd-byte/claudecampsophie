-- 0820: the family purge also removes the family's support cases and their messages (0810).
-- The whole function is re-created from its latest definition (0710_jobs_hardening.sql) with two
-- deletes in the family-scope branch; nothing else changes. A child-scoped purge leaves support
-- cases in place: they are the parent's text. Execute grants are unchanged (0620).

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

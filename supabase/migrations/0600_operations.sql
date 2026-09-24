-- 0600_operations.sql
-- Deletion requests (tombstone-first), a durable job ledger (idempotency, retries, dead letters),
-- notification devices and deliveries (generic payloads only), AI/content safety reports and
-- private data exports. Depends on 0001 and 0100. Spec P4, P14, E4 (Deletion, Scheduling), V3.

-- ---------------------------------------------------------------------------------------------
-- Deletion (spec P4, E4): tombstone first, stop processing, purge within the documented target
-- ---------------------------------------------------------------------------------------------

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  scope text not null check (scope in ('family', 'child')),
  child_id uuid,
  requested_by uuid not null references auth.users (id),
  status text not null default 'requested'
    check (status in ('requested', 'processing', 'completed', 'cancelled')),
  requested_at timestamptz not null default now(),
  -- Proposed 30-day maximum for active-store deletion (spec P4); backups expire separately.
  complete_by timestamptz not null default (now() + interval '30 days'),
  completed_at timestamptz,
  purge_report jsonb,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((scope = 'child') = (child_id is not null)),
  check ((status = 'completed') = (completed_at is not null))
);

create unique index deletion_requests_one_open
  on public.deletion_requests (family_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('requested', 'processing');

-- Parent-initiated deletion: requires recent step-up; tombstones immediately, revokes child sessions.
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

  insert into public.deletion_requests (family_id, scope, child_id, requested_by)
    values (p_family, case when p_child is null then 'family' else 'child' end, p_child, uid)
    returning * into req;

  -- Stop access and processing immediately (the purge job does the rest).
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

  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (p_family, uid, 'parent', 'deletion.requested', req.scope, coalesce(p_child, p_family)::text);
  return req;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Durable job ledger. Cloudflare Queues/Cron deliver work; this table provides idempotency,
-- retry accounting, dead letters and deletion cancellation. Payloads hold references only.
-- ---------------------------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'scan_process', 'daily_set_generate', 'thursday_review_generate', 'review_top_up',
    'promo_month_generate', 'promo_offer_provision', 'promo_reconcile', 'donation_accrue',
    'payout_prepare', 'entitlement_reconcile', 'retention_purge', 'deletion_purge',
    'notification_send', 'export_build')),
  -- e.g. reviewIdempotencyKey(child, subject, week, version) or `${template}:${month}`.
  idempotency_key text not null unique check (char_length(idempotency_key) between 3 and 300),
  family_id uuid references public.families (id),
  child_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'succeeded', 'failed_retryable', 'failed_final', 'cancelled', 'dead_letter')),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (attempts <= max_attempts)
);

create index jobs_ready on public.jobs (run_after) where status in ('queued', 'failed_retryable');

-- A job for a tombstoned family can never start (no resurrection after deletion races).
create or replace function app.guard_job() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger jobs_guard before insert or update on public.jobs
  for each row execute function app.guard_job();

-- ---------------------------------------------------------------------------------------------
-- Notifications (spec P14): parent devices by default; child reminders need parent permission.
-- Payloads are generic readiness text keys — never answers, struggles or photos.
-- ---------------------------------------------------------------------------------------------

create table public.notification_devices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  owner_kind text not null check (owner_kind in ('parent', 'child')),
  user_id uuid references auth.users (id),
  child_id uuid,
  platform text not null check (platform in ('ios', 'android', 'web')),
  opted_in boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((owner_kind = 'parent') = (user_id is not null)),
  check ((owner_kind = 'child') = (child_id is not null))
);

create table private.push_tokens (
  device_id uuid primary key references public.notification_devices (id),
  provider text not null check (provider in ('expo', 'apns', 'fcm')),
  token text not null,
  updated_at timestamptz not null default now()
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  device_id uuid not null references public.notification_devices (id),
  message_key text not null check (message_key in (
    'review_ready', 'daily_ready', 'scan_ready', 'needs_parent_review', 'reward_requested',
    'billing_attention', 'promo_confirmed')),
  dedupe_key text not null unique,
  status text not null default 'scheduled' check (status in (
    'scheduled', 'sent', 'failed', 'suppressed_quiet_hours', 'suppressed_opt_out', 'suppressed_permission')),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Safety reports (spec P4, AC_SECURITY_01)
-- ---------------------------------------------------------------------------------------------

create table public.safety_reports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid,
  reporter_kind text not null check (reporter_kind in ('child', 'parent')),
  category text not null check (category in ('unsafe_content', 'wrong_or_confusing', 'upsetting', 'answer_revealed', 'other')),
  question_id uuid references public.extracted_questions (id),
  feedback_id uuid references public.child_feedback (id),
  note text check (char_length(note) <= 500),
  status text not null default 'open' check (status in ('open', 'triaged', 'escalated', 'resolved')),
  created_at timestamptz not null default now(),
  triaged_at timestamptz,
  resolved_at timestamptz,
  resolution_note text,
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create index safety_reports_open on public.safety_reports (created_at) where status in ('open', 'escalated');

create or replace function public.child_report_content(p_category text, p_question uuid default null, p_feedback uuid default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me uuid := app.current_child_id();
  fam uuid := app.current_child_family_id();
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
  insert into public.safety_reports (family_id, child_id, reporter_kind, category, question_id, feedback_id)
    values (fam, me, 'child', p_category, p_question, p_feedback)
    returning id into report_id;
  return report_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Private exports (spec P8/P10): answer-key exports need a recent step-up at request time.
-- ---------------------------------------------------------------------------------------------

create table public.data_exports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  requested_by uuid not null references auth.users (id),
  kind text not null check (kind in ('family_data', 'progress_pdf', 'progress_csv', 'review_questions_pdf', 'review_answer_key_pdf')),
  child_id uuid,
  status text not null default 'queued' check (status in ('queued', 'ready', 'failed', 'expired')),
  storage_path text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create or replace function public.request_export(p_family uuid, p_kind text, p_child uuid default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
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

revoke execute on function public.request_deletion(uuid, uuid) from public, anon, pl_child;
revoke execute on function public.request_export(uuid, text, uuid) from public, anon, pl_child;
revoke execute on function public.child_report_content(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_deletion(uuid, uuid) to authenticated, service_role;
grant execute on function public.request_export(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.child_report_content(text, uuid, uuid) to pl_child, service_role;

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.deletion_requests enable row level security;
alter table public.jobs enable row level security;
alter table public.notification_devices enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.safety_reports enable row level security;
alter table public.data_exports enable row level security;

revoke all on public.deletion_requests, public.jobs, public.notification_devices,
  public.notification_deliveries, public.safety_reports, public.data_exports from anon;
revoke insert, update, delete on public.deletion_requests, public.jobs, public.notification_devices,
  public.notification_deliveries, public.safety_reports, public.data_exports from authenticated;

grant insert (family_id, reporter_kind, category, question_id, note) on public.safety_reports to authenticated;
grant update (opted_in) on public.notification_devices to authenticated;

create policy deletion_requests_member_read on public.deletion_requests
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());
create policy jobs_admin_read on public.jobs
  for select to authenticated using (app.is_owner_admin());
create policy notification_devices_member_read on public.notification_devices
  for select to authenticated using (app.is_family_member(family_id));
create policy notification_devices_member_update on public.notification_devices
  for update to authenticated using (app.is_family_member(family_id)) with check (app.is_family_member(family_id));
create policy notification_deliveries_member_read on public.notification_deliveries
  for select to authenticated using (app.is_family_member(family_id));
create policy safety_reports_member_read on public.safety_reports
  for select to authenticated using (app.is_family_member(family_id) or app.is_owner_admin());
create policy safety_reports_parent_insert on public.safety_reports
  for insert to authenticated with check (app.is_family_member(family_id) and reporter_kind = 'parent');
create policy data_exports_member_read on public.data_exports
  for select to authenticated using (app.is_family_member(family_id));

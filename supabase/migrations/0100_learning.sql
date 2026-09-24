-- 0100_learning.sql
-- Subjects, test dates and schedules, homework assignments with the processing state machine,
-- source pages in private storage, extracted questions, PRIVATE parent solutions, child-safe
-- results and feedback, immutable attempts with parent overrides, question templates, practice
-- sets/items with private keys. Depends on 0001. Spec P5–P8, P13; docs/Architecture.md §3–4.

-- ---------------------------------------------------------------------------------------------
-- Subjects, study material and schedules
-- ---------------------------------------------------------------------------------------------

create table public.child_subjects (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  -- The six supported areas, or a parent-added custom subject.
  subject_key text not null check (subject_key in (
    'math', 'reading', 'spelling_vocabulary', 'grammar_writing', 'science', 'social_studies', 'custom')),
  display_name text not null check (char_length(display_name) between 1 and 60),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (id, family_id)
);

create unique index child_subjects_unique_name on public.child_subjects (child_id, lower(display_name));

create table public.test_dates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  subject_id uuid not null,
  test_date date not null,
  scope_notes text check (char_length(scope_notes) <= 2000),
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  foreign key (subject_id, family_id) references public.child_subjects (id, family_id),
  unique (subject_id, test_date)
);

create table public.study_materials (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  subject_id uuid,
  kind text not null check (kind in ('spelling_list', 'study_guide', 'taught_notes', 'reading_passage')),
  -- Short text (spelling words, notes). Larger study guides live in private storage.
  content_text text check (char_length(content_text) <= 20000),
  storage_path text,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  foreign key (subject_id, family_id) references public.child_subjects (id, family_id),
  check (content_text is not null or storage_path is not null)
);

create table public.learning_schedules (
  child_id uuid primary key,
  family_id uuid not null references public.families (id),
  review_weekday smallint not null default 4 check (review_weekday between 1 and 7),
  review_local_time time not null default '16:00',
  review_questions_per_subject smallint not null default 8 check (review_questions_per_subject between 4 and 20),
  schedule_version integer not null default 1 check (schedule_version >= 1),
  daily_local_time time not null default '15:30',
  daily_question_count smallint not null default 5 check (daily_question_count between 3 and 10),
  paused_from date,
  paused_to date,
  quiet_hours_start time,
  quiet_hours_end time,
  child_reminders_permitted boolean not null default false,
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((paused_from is null) = (paused_to is null)),
  check (paused_to is null or paused_to >= paused_from)
);

-- ---------------------------------------------------------------------------------------------
-- Homework assignments and processing (spec P5 state machine)
-- ---------------------------------------------------------------------------------------------

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  subject_id uuid,
  status text not null default 'draft' check (status in (
    'draft', 'uploading', 'queued', 'extracting', 'checking', 'verifying', 'ready',
    'needs_rescan', 'needs_parent_review', 'failed_retryable', 'failed_final', 'cancelled', 'deleted')),
  -- Client idempotency key: duplicate create/finalize never creates a second job or quota charge.
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  created_by_kind text not null check (created_by_kind in ('parent', 'child')),
  page_count smallint not null default 0 check (page_count between 0 and 50),
  processing_attempts smallint not null default 0 check (processing_attempts >= 0),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  foreign key (subject_id, family_id) references public.child_subjects (id, family_id),
  unique (id, family_id)
);

create index assignments_child on public.assignments (child_id, created_at desc);

create or replace function app.guard_assignment_transition() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger assignments_transition before update on public.assignments
  for each row execute function app.guard_assignment_transition();

create table public.source_pages (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  page_number smallint not null check (page_number between 1 and 50),
  -- `{family_id}/{child_id}/{assignment_id}/{page_id}.{ext}` in the private `homework` bucket.
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/heic', 'application/pdf')),
  byte_size integer not null check (byte_size between 1 and 15728640),
  width integer check (width > 0),
  height integer check (height > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  metadata_stripped boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (assignment_id, family_id) references public.assignments (id, family_id),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (assignment_id, page_number)
);

create table public.extracted_questions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null,
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  page_id uuid not null references public.source_pages (id),
  question_number text not null check (char_length(question_number) between 1 and 20),
  bounding_box jsonb,
  -- Printed question text and the student's own answer (never the key or teacher annotations).
  prompt_text text not null check (char_length(prompt_text) <= 4000),
  student_answer_text text check (char_length(student_answer_text) <= 4000),
  answer_kind text not null check (answer_kind in (
    'numeric', 'quantity', 'division_remainder', 'multiple_choice', 'spelling', 'exact_text',
    'open_response', 'writing')),
  subject_key text not null,
  skill text not null check (char_length(skill) between 1 and 120),
  subskill text,
  grade_estimate smallint check (grade_estimate between 0 and 12),
  uncertainty text check (uncertainty in ('low', 'medium', 'high')),
  transcription_version integer not null default 1,
  -- Parent corrections are kept distinguishable from the original transcription (spec P5).
  corrected_prompt_text text,
  corrected_student_answer_text text,
  corrected_by uuid references auth.users (id),
  corrected_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (assignment_id, family_id) references public.assignments (id, family_id),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (assignment_id, page_id, question_number)
);

create index extracted_questions_assignment on public.extracted_questions (assignment_id);

-- PRIVATE: correct answers, worked solutions, rubrics. Never exposed to any client role.
create table private.question_solutions (
  question_id uuid primary key references public.extracted_questions (id),
  family_id uuid not null references public.families (id),
  correct_answer text not null,
  worked_solution text not null,
  rubric jsonb,
  misconception text,
  evidence jsonb,
  grading_provenance jsonb not null default '{}'::jsonb,
  grader_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Child-safe verdicts. No answer, no confidence score, no rubric.
create table public.question_results (
  question_id uuid primary key references public.extracted_questions (id),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  verdict text not null check (verdict in (
    'correct', 'incorrect', 'unresolved', 'unanswered', 'rubric', 'needs_parent_review')),
  route text not null check (route in ('deterministic', 'agreement', 'escalated', 'parent_review')),
  disagreement boolean not null default false,
  grader_version text not null,
  graded_at timestamptz not null default now(),
  parent_override_verdict text check (parent_override_verdict in ('correct', 'incorrect', 'unresolved')),
  overridden_by uuid references auth.users (id),
  overridden_at timestamptz,
  override_reason text check (char_length(override_reason) <= 300),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  check ((parent_override_verdict is null) = (overridden_at is null))
);

-- Guarded child feedback (hints, method steps, analogous examples). Released only after the
-- answer-guard passes in the API; `guard_version` records which guard approved it.
create table public.child_feedback (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.extracted_questions (id),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  kind text not null check (kind in ('hint', 'method_step', 'analogous_example', 'encouragement', 'template_fallback')),
  body text not null check (char_length(body) between 1 and 2000),
  guard_version text not null,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create index child_feedback_question on public.child_feedback (question_id, created_at);
create trigger child_feedback_append_only before update or delete on public.child_feedback
  for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- Learning evidence (spec P7): immutable attempts + separate parent overrides
-- ---------------------------------------------------------------------------------------------

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  -- Extracted question id or practice item id.
  question_instance_id uuid not null,
  source text not null check (source in ('homework', 'daily', 'review')),
  subject_key text not null,
  skill text not null,
  attempt_number smallint not null check (attempt_number >= 1),
  hints_used smallint not null default 0 check (hints_used >= 0),
  correctness text not null check (correctness in ('correct', 'incorrect', 'unresolved')),
  independent boolean generated always as (attempt_number = 1 and hints_used = 0) stored,
  grader_version text not null,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (question_instance_id, attempt_number)
);

create index attempts_child_skill on public.attempts (child_id, skill, occurred_at desc);
create trigger attempts_append_only before update or delete on public.attempts
  for each row execute function app.prevent_mutation();

create table public.attempt_overrides (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts (id),
  family_id uuid not null references public.families (id),
  correctness text not null check (correctness in ('correct', 'incorrect', 'unresolved')),
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  overridden_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create trigger attempt_overrides_append_only before update or delete on public.attempt_overrides
  for each row execute function app.prevent_mutation();

create table public.target_answer_attempts (
  question_instance_id uuid primary key,
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  -- Server-side count for the 3-try limit; never reset by resubmission (spec P6).
  count smallint not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

-- ---------------------------------------------------------------------------------------------
-- Question bank and practice
-- ---------------------------------------------------------------------------------------------

create table public.question_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  subject_key text not null check (subject_key in (
    'math', 'reading', 'spelling_vocabulary', 'grammar_writing', 'science', 'social_studies')),
  skill text not null,
  grade_min smallint not null check (grade_min between 0 and 12),
  grade_max smallint not null check (grade_max between grade_min and 12),
  -- Child-safe prompt template and parameter constraints. The answer spec lives in private.
  prompt_template jsonb not null,
  parameters jsonb not null default '{}'::jsonb,
  source text not null check (source in ('original', 'licensed')),
  license_note text,
  review_status text not null default 'draft' check (review_status in ('draft', 'reviewed', 'retired')),
  created_at timestamptz not null default now()
);

create table private.template_answer_specs (
  template_id uuid primary key references public.question_templates (id),
  answer_spec jsonb not null,
  explanation text
);

create table public.practice_sets (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  kind text not null check (kind in ('daily', 'thursday_review', 'top_up')),
  -- dailySetKey / reviewIdempotencyKey from @pencillift/domain/scheduling: exactly one set per key.
  set_key text not null unique,
  subject_key text,
  local_date date,
  review_week text check (review_week ~ '^\d{4}-W\d{2}$'),
  version smallint not null default 1 check (version >= 1),
  status text not null default 'generating'
    check (status in ('generating', 'ready', 'in_progress', 'completed', 'expired', 'failed')),
  mix jsonb not null default '{}'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (id, family_id)
);

create index practice_sets_child on public.practice_sets (child_id, created_at desc);

create table public.practice_items (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null,
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  position smallint not null check (position between 1 and 200),
  subject_key text not null,
  skill text not null,
  category text not null check (category in ('weak', 'spaced', 'confidence', 'cumulative', 'fallback', 'prerequisite')),
  template_id uuid references public.question_templates (id),
  -- Child-safe rendered prompt (question only; never the answer).
  prompt jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (set_id, family_id) references public.practice_sets (id, family_id),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (set_id, position)
);

create table private.practice_item_keys (
  item_id uuid primary key references public.practice_items (id),
  family_id uuid not null references public.families (id),
  answer_spec jsonb not null,
  explanation text
);

-- ---------------------------------------------------------------------------------------------
-- Parent-only access to solutions and overrides (recent step-up required, spec P3/P5)
-- ---------------------------------------------------------------------------------------------

create or replace function public.parent_assignment_solutions(p_assignment uuid)
returns table (
  question_id uuid,
  question_number text,
  correct_answer text,
  worked_solution text,
  rubric jsonb,
  misconception text
)
language plpgsql stable security definer
set search_path = ''
as $$
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

create or replace function public.parent_override_result(p_question uuid, p_verdict text, p_reason text)
returns public.question_results
language plpgsql security definer
set search_path = ''
as $$
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

revoke execute on function public.parent_assignment_solutions(uuid) from public, anon, pl_child;
revoke execute on function public.parent_override_result(uuid, text, text) from public, anon, pl_child;
grant execute on function public.parent_assignment_solutions(uuid) to authenticated, service_role;
grant execute on function public.parent_override_result(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Private homework storage (spec P4/P5). Uploads use API-issued signed URLs (service role).
-- ---------------------------------------------------------------------------------------------

-- Returns null instead of raising for non-UUID text, so one malformed object path cannot make every
-- policy-filtered storage query error.
create or replace function app.try_uuid(p text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('homework', 'homework', false, 15728640,
        array['image/jpeg', 'image/png', 'image/heic', 'application/pdf'])
on conflict (id) do update set public = false;

create policy homework_parent_read on storage.objects
  for select to authenticated
  using (bucket_id = 'homework'
         and app.is_family_member(app.try_uuid((storage.foldername(name))[1])));

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.child_subjects enable row level security;
alter table public.test_dates enable row level security;
alter table public.study_materials enable row level security;
alter table public.learning_schedules enable row level security;
alter table public.assignments enable row level security;
alter table public.source_pages enable row level security;
alter table public.extracted_questions enable row level security;
alter table public.question_results enable row level security;
alter table public.child_feedback enable row level security;
alter table public.attempts enable row level security;
alter table public.attempt_overrides enable row level security;
alter table public.target_answer_attempts enable row level security;
alter table public.question_templates enable row level security;
alter table public.practice_sets enable row level security;
alter table public.practice_items enable row level security;

revoke all on public.child_subjects, public.test_dates, public.study_materials,
  public.learning_schedules, public.assignments, public.source_pages, public.extracted_questions,
  public.question_results, public.child_feedback, public.attempts, public.attempt_overrides,
  public.target_answer_attempts, public.question_templates, public.practice_sets,
  public.practice_items from anon;

-- Processing, grading, attempts and practice are written by the API/jobs only.
revoke insert, update, delete on public.assignments, public.source_pages, public.extracted_questions,
  public.question_results, public.child_feedback, public.attempts, public.attempt_overrides,
  public.target_answer_attempts, public.question_templates, public.practice_sets,
  public.practice_items, public.child_subjects, public.test_dates, public.study_materials,
  public.learning_schedules from authenticated;

-- Parents manage subjects, test dates, study material and schedules directly (low-risk settings).
grant insert (family_id, child_id, subject_key, display_name, enabled) on public.child_subjects to authenticated;
grant update (display_name, enabled) on public.child_subjects to authenticated;
grant insert (family_id, child_id, subject_id, test_date, scope_notes) on public.test_dates to authenticated;
grant delete on public.test_dates to authenticated;
grant insert (family_id, child_id, subject_id, kind, content_text) on public.study_materials to authenticated;
grant insert (child_id, family_id, review_weekday, review_local_time, review_questions_per_subject,
  daily_local_time, daily_question_count, paused_from, paused_to, quiet_hours_start, quiet_hours_end,
  child_reminders_permitted) on public.learning_schedules to authenticated;
grant update (review_weekday, review_local_time, review_questions_per_subject, daily_local_time,
  daily_question_count, paused_from, paused_to, quiet_hours_start, quiet_hours_end,
  child_reminders_permitted) on public.learning_schedules to authenticated;

create policy child_subjects_member on public.child_subjects
  for all to authenticated using (app.is_family_member(family_id)) with check (app.is_family_member(family_id));
create policy test_dates_member on public.test_dates
  for all to authenticated using (app.is_family_member(family_id)) with check (app.is_family_member(family_id));
create policy study_materials_member on public.study_materials
  for all to authenticated using (app.is_family_member(family_id)) with check (app.is_family_member(family_id));
create policy learning_schedules_member on public.learning_schedules
  for all to authenticated using (app.is_family_member(family_id)) with check (app.is_family_member(family_id));

create policy assignments_member_read on public.assignments
  for select to authenticated using (app.is_family_member(family_id));
create policy source_pages_member_read on public.source_pages
  for select to authenticated using (app.is_family_member(family_id));
create policy extracted_questions_member_read on public.extracted_questions
  for select to authenticated using (app.is_family_member(family_id));
create policy question_results_member_read on public.question_results
  for select to authenticated using (app.is_family_member(family_id));
create policy child_feedback_member_read on public.child_feedback
  for select to authenticated using (app.is_family_member(family_id));
create policy attempts_member_read on public.attempts
  for select to authenticated using (app.is_family_member(family_id));
create policy attempt_overrides_member_read on public.attempt_overrides
  for select to authenticated using (app.is_family_member(family_id));
create policy target_answer_attempts_member_read on public.target_answer_attempts
  for select to authenticated using (app.is_family_member(family_id));
create policy practice_sets_member_read on public.practice_sets
  for select to authenticated using (app.is_family_member(family_id));
create policy practice_items_member_read on public.practice_items
  for select to authenticated using (app.is_family_member(family_id));
create policy question_templates_admin_read on public.question_templates
  for select to authenticated using (app.is_owner_admin());

-- Children: explicit column allowlists, own rows only. No solutions, no confidence, no templates.
grant select (id, child_id, subject_key, display_name, enabled) on public.child_subjects to pl_child;
grant select (id, child_id, subject_id, status, page_count, created_at, updated_at) on public.assignments to pl_child;
grant select (id, assignment_id, child_id, question_number, prompt_text, student_answer_text, answer_kind, subject_key)
  on public.extracted_questions to pl_child;
grant select (question_id, child_id, verdict, graded_at) on public.question_results to pl_child;
grant select (id, question_id, child_id, kind, body, created_at) on public.child_feedback to pl_child;
grant select (id, child_id, kind, subject_key, local_date, review_week, version, status, ready_at)
  on public.practice_sets to pl_child;
grant select (id, set_id, child_id, position, subject_key, skill, category, prompt) on public.practice_items to pl_child;

create policy child_subjects_child_read on public.child_subjects
  for select to pl_child using (child_id = app.current_child_id());
create policy assignments_child_read on public.assignments
  for select to pl_child using (child_id = app.current_child_id() and status <> 'deleted');
create policy extracted_questions_child_read on public.extracted_questions
  for select to pl_child using (child_id = app.current_child_id());
create policy question_results_child_read on public.question_results
  for select to pl_child using (child_id = app.current_child_id());
create policy child_feedback_child_read on public.child_feedback
  for select to pl_child using (child_id = app.current_child_id());
create policy practice_sets_child_read on public.practice_sets
  for select to pl_child using (child_id = app.current_child_id() and status in ('ready', 'in_progress', 'completed'));
create policy practice_items_child_read on public.practice_items
  for select to pl_child
  using (child_id = app.current_child_id()
         and exists (select 1 from public.practice_sets s
                      where s.id = set_id and s.status in ('ready', 'in_progress', 'completed')));

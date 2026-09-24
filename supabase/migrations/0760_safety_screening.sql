-- 0760_safety_screening.sql
-- Child-safety screening (spec P4; AC_SECURITY_02). The scan job screens each extracted answer
-- with the deterministic screen in @pencillift/domain/safety. On a severe-risk answer it makes no
-- coaching call, shows the child a reviewed 'safety' template and files an escalated SYSTEM report
-- for the owner's review queue (docs/Deployment_Runbook.md 5.1). System reports carry ids and
-- screen codes only, never homework text. A report whose concern may involve the household (screen
-- codes abuse, sexual, secrecy) is held from the family's list until a reviewer releases it, and so
-- is a child's own report about that question (the results screen's "Get help" button). A reviewer
-- may clear a system report as a false match (section 5): the child's notice is then hidden and the
-- question is graded normally for that transcription.

-- ---------------------------------------------------------------------------------------------
-- 1. The reviewed safety template is its own child feedback kind (rendered distinctly and calmly).
-- ---------------------------------------------------------------------------------------------

alter table public.child_feedback drop constraint child_feedback_kind_check;
alter table public.child_feedback add constraint child_feedback_kind_check
  check (kind in ('hint', 'method_step', 'analogous_example', 'encouragement', 'template_fallback', 'safety'));

-- ---------------------------------------------------------------------------------------------
-- 2. System safety reports
-- ---------------------------------------------------------------------------------------------

alter table public.safety_reports drop constraint safety_reports_reporter_kind_check;
alter table public.safety_reports add constraint safety_reports_reporter_kind_check
  check (reporter_kind in ('child', 'parent', 'system'));

alter table public.safety_reports drop constraint safety_reports_category_check;
alter table public.safety_reports add constraint safety_reports_category_check
  check (category in ('unsafe_content', 'wrong_or_confusing', 'upsetting', 'answer_revealed', 'other', 'severe_risk'));

alter table public.safety_reports
  -- The transcription the screen read (the question's corrected_at, else its created_at): one
  -- system report per question per transcription, so a crash replay or recheck never duplicates it.
  add column transcription_at timestamptz,
  -- Screen category codes (e.g. 'self_harm'). Owner admin queue only: families cannot read them.
  add column screen_categories text[],
  add column screen_version text check (char_length(screen_version) <= 40),
  -- Decision (runbook 5.1; proposed default, owner and counsel to approve): a system report whose
  -- screen codes include abuse, sexual or secrecy starts HELD (false) because the concern may
  -- involve someone in the household; the owner admin releases it (true) after review. A child's
  -- report about a question with a held system report starts held too (child_report_content
  -- below): otherwise the "Get help" report would show the household the held question at once
  -- (RV-child-safety-6). Families read only visible reports (policy below) and cannot read this flag.
  add column family_visible boolean not null default true,
  -- Round 3 (CHK2-CS-5; spec P4 "human review procedures"): a reviewer resolved this system report
  -- as a false match. The clearance is per question and transcription (the report's question_id and
  -- transcription_at): the scan grades that transcription normally and the child's results stop
  -- showing its safety notice. Only a code, never the answer text.
  add column resolution text check (resolution in ('false_match'));

-- Parent reports are never held: a guardian always sees the report they filed.
alter table public.safety_reports add constraint safety_reports_hold_kind
  check (family_visible or reporter_kind in ('system', 'child'));

-- Decision: a system report is always 'severe_risk', names its child and question, carries no note
-- (no homework text), starts 'escalated' (runbook 5.1: serious by default) and can only move on to
-- 'resolved' (the admin workflow is forward-only). Only system reports carry screen columns, and
-- only system reports use 'severe_risk', so no parent or child report can pose as one.
alter table public.safety_reports add constraint safety_reports_system_shape check (
  ((reporter_kind = 'system') = (category = 'severe_risk'))
  and (
    reporter_kind <> 'system'
    or (
      child_id is not null and question_id is not null and note is null
      and status in ('escalated', 'resolved')
      and transcription_at is not null and screen_version is not null
      and screen_categories is not null
      and cardinality(screen_categories) between 1 and 6
      and screen_categories <@ array['self_harm', 'abuse', 'violence', 'sexual', 'secrecy', 'personal_contact']::text[]
    )
  )
  and (
    reporter_kind = 'system'
    or (transcription_at is null and screen_categories is null and screen_version is null)
  )
);

create unique index safety_reports_system_once
  on public.safety_reports (question_id, transcription_at) where reporter_kind = 'system';

-- A false-match clearance belongs to a resolved system report.
alter table public.safety_reports add constraint safety_reports_resolution_shape check (
  resolution is null or (reporter_kind = 'system' and status = 'resolved')
);

-- [BUG] The purge (app.purge_family_data, 0710) deletes child_feedback before safety_reports, so a
-- report linked to a hint or template (a child's report from a hint, every system report) made the
-- feedback delete fail and blocked the child's deletion. The link is cleared instead; the purge
-- then deletes the report itself with the child's other data.
alter table public.safety_reports drop constraint safety_reports_feedback_id_fkey;
alter table public.safety_reports add constraint safety_reports_feedback_id_fkey
  foreign key (feedback_id) references public.child_feedback (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- 3. A child's report about a held flagged question is held with it (RV-child-safety-6). Same
--    signature, checks and grants as 0600; only the hold is new. A held system report (any
--    transcription) on the question named, or on the question the named feedback row belongs to,
--    holds the child's report; the reviewer releases each report on its own (runbook 5.1).
-- ---------------------------------------------------------------------------------------------

create or replace function public.child_report_content(p_category text, p_question uuid default null, p_feedback uuid default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
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

-- ---------------------------------------------------------------------------------------------
-- 4. False-match clearance guard (round 3, CHK2-CS-5). A clearance is set in the same update that
--    resolves the report (resolved is final), never changes afterwards, and a cleared report that
--    was held is never released: the family never learns of a held report that was cleared. The
--    admin API enforces the same rules; this is the second layer for any service-role writer.
-- ---------------------------------------------------------------------------------------------

create or replace function app.guard_safety_report_resolution() returns trigger
language plpgsql
set search_path = ''
as $$
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

create trigger safety_reports_resolution_guard before update on public.safety_reports
  for each row execute function app.guard_safety_report_resolution();

-- ---------------------------------------------------------------------------------------------
-- 5. Grants: families keep reading their reports (RLS unchanged: members of the family only), but
--    not the screen columns or the reviewer's resolution note; no client role can create a system
--    report (authenticated inserts are limited to reporter_kind 'parent' by the 0600 policy;
--    pl_child has no table privilege and its report RPC hardcodes 'child').
-- ---------------------------------------------------------------------------------------------

revoke select on public.safety_reports from authenticated;
-- family_visible is not granted: a held report is invisible and the flag itself is not exposed.
-- resolution_note is not granted (RV-child-safety-8): runbook 5.1 has the reviewer record authority
-- and family-contact decisions there; the family sees the status and timestamps only. `resolution`
-- is granted (round 3): a visible system report that was cleared as a false match must not keep
-- telling the family that the child sees a safety message (the family copy says it was cleared); a
-- held report stays invisible (policy below), so its clearance is never shown.
grant select (id, family_id, child_id, reporter_kind, category, question_id, feedback_id, note, status,
              created_at, triaged_at, resolved_at, transcription_at, resolution)
  on public.safety_reports to authenticated;

-- Families read their visible reports only (0670's member policy plus the hold). Parent inserts keep
-- the default (visible): the 0600 insert grant does not include family_visible.
drop policy safety_reports_member_read on public.safety_reports;
create policy safety_reports_member_read on public.safety_reports
  for select to authenticated using (app.is_family_member(family_id) and family_visible);

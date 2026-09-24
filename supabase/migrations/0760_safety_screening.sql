-- 0760_safety_screening.sql
-- Child-safety screening (spec P4; AC_SECURITY_02). The scan job screens each extracted answer
-- with the deterministic screen in @pencillift/domain/safety. On a severe-risk answer it makes no
-- coaching call, shows the child a reviewed 'safety' template and files an escalated SYSTEM report
-- for the owner's review queue (docs/Deployment_Runbook.md 5.1). System reports carry ids and
-- screen codes only, never homework text. A report whose concern may involve the household (screen
-- codes abuse, sexual, secrecy) is held from the family's list until a reviewer releases it.

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
  -- involve someone in the household; the owner admin releases it (true) after review. Families
  -- read only visible reports (policy below) and cannot read this flag.
  add column family_visible boolean not null default true;

alter table public.safety_reports add constraint safety_reports_hold_system_only
  check (family_visible or reporter_kind = 'system');

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

-- [BUG] The purge (app.purge_family_data, 0710) deletes child_feedback before safety_reports, so a
-- report linked to a hint or template (a child's report from a hint, every system report) made the
-- feedback delete fail and blocked the child's deletion. The link is cleared instead; the purge
-- then deletes the report itself with the child's other data.
alter table public.safety_reports drop constraint safety_reports_feedback_id_fkey;
alter table public.safety_reports add constraint safety_reports_feedback_id_fkey
  foreign key (feedback_id) references public.child_feedback (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- 3. Grants: families keep reading their reports (RLS unchanged: members of the family only), but
--    not the screen columns; no client role can create a system report (authenticated inserts are
--    limited to reporter_kind 'parent' by the 0600 policy; pl_child has no table privilege and its
--    report RPC hardcodes 'child').
-- ---------------------------------------------------------------------------------------------

revoke select on public.safety_reports from authenticated;
-- family_visible is not granted: a held report is invisible and the flag itself is not exposed.
grant select (id, family_id, child_id, reporter_kind, category, question_id, feedback_id, note, status,
              created_at, triaged_at, resolved_at, resolution_note, transcription_at)
  on public.safety_reports to authenticated;

-- Families read their visible reports only (0670's member policy plus the hold). Parent inserts keep
-- the default (visible): the 0600 insert grant does not include family_visible.
drop policy safety_reports_member_read on public.safety_reports;
create policy safety_reports_member_read on public.safety_reports
  for select to authenticated using (app.is_family_member(family_id) and family_visible);

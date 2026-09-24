-- 0670_privacy_hardening.sql
-- Schema requests SR-PRIVACY-1 and SR-PRIVACY-3 from the privacy vertical.

-- A report linked to a question or hint always names its child, so purging that child removes the
-- report instead of the question_id foreign key blocking app.purge_family_data.
alter table public.safety_reports
  add constraint safety_reports_linked_item_has_child
  check ((question_id is null and feedback_id is null) or child_id is not null);

-- Least privilege at the database layer: an owner admin no longer reads every family's reports
-- (including parents' free-text notes) through RLS. The admin queue is served by the API with the
-- service role after an aal2 owner check, selecting ids, category, status and timestamps only.
drop policy safety_reports_member_read on public.safety_reports;
create policy safety_reports_member_read on public.safety_reports
  for select to authenticated using (app.is_family_member(family_id));

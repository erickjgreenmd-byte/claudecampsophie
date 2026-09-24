-- 0650_learning_runtime.sql
-- Runtime additions for daily practice and Thursday reviews (spec P7, P8; AC_LEARNING_03/07/08/09).
-- Depends on 0001, 0100, 0620 (purge flag).
--
-- 1. practice_sets.release_at: the instant a review becomes visible to the child. Jobs generate it
--    ahead of time (lead time) so it is READY before release even with the app closed; the child API
--    shows it only from release_at on.
-- 2. practice_sets.evidence_cutoff_at: evidence after this instant is late evidence (optional,
--    versioned top-ups never overwrite a started or completed review).
-- 3. practice_sets.child_intro: an optional guarded, child-safe welcome line (AI personalization).
-- 4. schedule_version is maintained by the database: changing the review weekday/time, or adding or
--    removing a test date, bumps it, so review job keys (child, subject, week, version) change and
--    stale not-started jobs are replaced. Parents cannot set the version directly (no grant).

alter table public.practice_sets
  add column release_at timestamptz,
  add column evidence_cutoff_at timestamptz,
  add column child_intro text check (child_intro is null or char_length(child_intro) between 1 and 200);

create index practice_sets_child_review on public.practice_sets (child_id, kind, review_week, subject_key);

-- Child column allowlist extended by the release instant and the guarded intro only.
grant select (release_at, child_intro) on public.practice_sets to pl_child;

create or replace function app.bump_schedule_version_on_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.review_weekday is distinct from old.review_weekday
     or new.review_local_time is distinct from old.review_local_time then
    new.schedule_version := old.schedule_version + 1;
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger learning_schedules_version before update on public.learning_schedules
  for each row execute function app.bump_schedule_version_on_change();

-- A test date change reschedules that subject's review (spec P8). SECURITY DEFINER because parents
-- hold no update grant on schedule_version; it only ever increments the row of the same child.
create or replace function app.bump_schedule_version_on_test_date() returns trigger
language plpgsql security definer
set search_path = ''
as $$
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

revoke execute on function app.bump_schedule_version_on_test_date() from public, anon, authenticated, pl_child;

create trigger test_dates_reschedule after insert or delete on public.test_dates
  for each row execute function app.bump_schedule_version_on_test_date();

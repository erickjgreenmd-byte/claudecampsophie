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
-- 5. RLS is the second layer for the release instant too (review finding RV-learning-db-1): a child
--    reads a set, and its questions, only from release_at on. The instant is the database clock, or
--    the API's request clock when the API passes it (transaction-local `pencillift.request_now`,
--    set by the API like the request claims; domain code takes `now` as input).
-- 6. attempts.evidence_key: the stable identity of the bank QUESTION behind a practice item (a
--    SHA-256 digest of its private instance key, never the key or answer), so the same question
--    served again in a later set is one distinct question in the evidence, not a new one (spec P7;
--    RV-learning-api-1). Null for homework attempts (their question id is already stable).
-- 7. attempts.meaningful: whether the attempt met the earning rule (a non-empty answer after the
--    family's minimum response time). A set earns its completion award only when every question
--    saw meaningful work (spec P9 "prevent rapid empty guesses from farming points";
--    RV-learning-api-3). Null for homework attempts.
-- 8. One base Thursday review per child, subject and ISO week, whatever the schedule version, so
--    two workers can never both save one (spec P8 idempotency; RV-learning-api-8). Top-ups are
--    kind 'top_up' and unaffected.

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

-- ---------------------------------------------------------------------------------------------
-- 5. Children see a set and its questions only from its release instant on
-- ---------------------------------------------------------------------------------------------

-- The instant a child request is evaluated at: the API's request clock when it set one for this
-- transaction (only the API opens pl_child transactions, as with request.jwt.claims), else now().
create or replace function app.child_request_instant() returns timestamptz
language sql stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('pencillift.request_now', true), '')::timestamptz, now())
$$;

revoke execute on function app.child_request_instant() from public, anon;
grant execute on function app.child_request_instant() to authenticated, service_role, pl_child;

drop policy practice_sets_child_read on public.practice_sets;
create policy practice_sets_child_read on public.practice_sets
  for select to pl_child
  using (child_id = app.current_child_id()
         and status in ('ready', 'in_progress', 'completed')
         and (release_at is null or release_at <= app.child_request_instant()));

drop policy practice_items_child_read on public.practice_items;
create policy practice_items_child_read on public.practice_items
  for select to pl_child
  using (child_id = app.current_child_id()
         and exists (select 1 from public.practice_sets s
                      where s.id = set_id and s.status in ('ready', 'in_progress', 'completed')
                        and (s.release_at is null or s.release_at <= app.child_request_instant())));

-- ---------------------------------------------------------------------------------------------
-- 6-7. Attempt evidence identity and earning-rule meaningfulness (written by the API only)
-- ---------------------------------------------------------------------------------------------

alter table public.attempts
  add column evidence_key text check (evidence_key is null or evidence_key ~ '^bank:[0-9a-f]{64}$'),
  add column meaningful boolean;

-- ---------------------------------------------------------------------------------------------
-- 8. At most one live base review per child/subject/week
-- ---------------------------------------------------------------------------------------------

create unique index practice_sets_one_base_review on public.practice_sets (child_id, subject_key, review_week)
  where kind = 'thursday_review' and status in ('generating', 'ready', 'in_progress', 'completed');

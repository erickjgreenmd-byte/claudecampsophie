-- 0850_hardening_r1_db2.sql
-- Hardening round 1, database findings DB-R1-05..07 (docs/Bug_Ledger.md).
--   1. DB-R1-05: test_dates, study_materials and assignments linked their subject through
--      (subject_id, family_id) only, so a parent's Data-API insert (the direct grants on test_dates
--      and study_materials) could name child A with a subject of child B in the same family, and the
--      scheduler then planned it under the wrong child. The API already checks the subject belongs
--      to the child (routes/learning.ts, routes/homework.ts); the database now does too:
--      child_subjects gains unique (id, child_id) and each subject link also references it. The
--      family-bound keys stay as they are.
--   2. DB-R1-06: support_cases.opened_by_user_id and support_case_messages.author_user_id were
--      `on delete set null`, but support_cases_parent_author / support_case_messages_parent_author
--      require the author on every parent row, so the action could only ever fail with a confusing
--      check violation. The action is dropped: closing an account is GoTrue's soft delete (0830),
--      the auth.users row stays and its id remains the case's pseudonymous author, like the ~40
--      other references to auth.users that carry no ON DELETE action.
--   3. DB-R1-07: private.child_refresh_tokens had no session_id index and public.child_sessions no
--      family index, so the per-session token revoke, the purge's token delete and the deletion
--      paths' family-wide session revoke scanned the tables; and nothing pruned ended sessions,
--      their rotated refresh tokens or ended adult step-ups (ids and timestamps only, but they grow
--      with every sign-in, refresh and PIN unlock). Two indexes plus app.prune_session_rows(interval)
--      for a housekeeping step in the tick (wired by the lead).

-- ---------------------------------------------------------------------------------------------
-- 1. Subject links are bound to the child (DB-R1-05)
-- ---------------------------------------------------------------------------------------------

-- A row already linking a subject of another child cannot be repaired by guessing which child it
-- meant, so the migration stops and names the tables instead of rewriting or deleting family data.
-- Only a hand-crafted Data-API request could create one (the apps never do).
do $$
declare
  n_test_dates integer;
  n_materials integer;
  n_assignments integer;
begin
  select count(*) into n_test_dates
    from public.test_dates t join public.child_subjects s on s.id = t.subject_id
   where s.child_id <> t.child_id;
  select count(*) into n_materials
    from public.study_materials m join public.child_subjects s on s.id = m.subject_id
   where s.child_id <> m.child_id;
  select count(*) into n_assignments
    from public.assignments a join public.child_subjects s on s.id = a.subject_id
   where s.child_id <> a.child_id;
  if n_test_dates + n_materials + n_assignments > 0 then
    raise exception 'rows link a subject of another child: test_dates %, study_materials %, assignments %',
      n_test_dates, n_materials, n_assignments
      using errcode = '23503',
            hint = 'Review each row with its family (clear the subject link or move it to the subject''s child) and re-run.';
  end if;
end
$$;

alter table public.child_subjects
  add constraint child_subjects_id_child_key unique (id, child_id);

alter table public.test_dates
  add constraint test_dates_subject_child_fkey
  foreign key (subject_id, child_id) references public.child_subjects (id, child_id);

-- subject_id is optional here: a row without a subject satisfies the key (MATCH SIMPLE).
alter table public.study_materials
  add constraint study_materials_subject_child_fkey
  foreign key (subject_id, child_id) references public.child_subjects (id, child_id);

alter table public.assignments
  add constraint assignments_subject_child_fkey
  foreign key (subject_id, child_id) references public.child_subjects (id, child_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Support-case authors carry no ON DELETE action (DB-R1-06)
-- ---------------------------------------------------------------------------------------------

-- Plain references (NO ACTION), as every other link to auth.users: a hard delete of an author is
-- refused by the key itself, and the soft delete that closes an account (0830) keeps the id as the
-- pseudonymous author. The parent-author checks are unchanged. assignee_user_id keeps its
-- `on delete set null` (nullable, no check) and ops_settings.updated_by likewise.
alter table public.support_cases
  drop constraint support_cases_opened_by_user_id_fkey,
  add constraint support_cases_opened_by_user_id_fkey
    foreign key (opened_by_user_id) references auth.users (id);

alter table public.support_case_messages
  drop constraint support_case_messages_author_user_id_fkey,
  add constraint support_case_messages_author_user_id_fkey
    foreign key (author_user_id) references auth.users (id);

comment on column public.support_cases.opened_by_user_id is
  'Pseudonymous author id. Stays after the account closes (Supabase soft delete, 0830); required for parent-opened cases.';
comment on column public.support_case_messages.author_user_id is
  'Pseudonymous author id. Stays after the account closes (Supabase soft delete, 0830); required for parent messages.';

-- ---------------------------------------------------------------------------------------------
-- 3. Session-table indexes and retention (DB-R1-07)
-- ---------------------------------------------------------------------------------------------

-- Serves the per-session token writes (apps/api/src/routes/child-auth.ts revoke on reuse and
-- logout), the purge's `delete from private.child_refresh_tokens t using public.child_sessions s
-- where t.session_id = s.id` (app.purge_family_data) and app.prune_session_rows below. Also the
-- referencing side of child_refresh_tokens.session_id, so a session delete does not scan tokens.
create index child_refresh_tokens_session on private.child_refresh_tokens (session_id);

-- Serves the family-wide revoke of live sessions in public.request_deletion,
-- app.inactivity_delete_family (0840) and the purge
-- (update public.child_sessions ... where family_id = .. and revoked_at is null).
create index child_sessions_family on public.child_sessions (family_id) where revoked_at is null;

-- Retention for the child session and adult step-up tables. A session or step-up has ended at the
-- earlier of its expiry and its revocation (a family deletion revokes sessions that had already
-- expired; they ended when they expired). Deletes, for rows that ended more than p_older_than ago:
--   * every refresh token of such a session (a live session keeps all of its tokens, however old:
--     a used token presented again is how rotation detects theft);
--   * the session itself;
--   * the adult step-up (private.adult_unlocks).
-- Aged by the database clock, the clock app.current_child_id() and app.has_recent_adult_unlock()
-- compare these columns with. Returns the number of rows deleted across the three tables.
-- Service-only; wired into the scheduled tick by the lead (apps/api/src/auth/housekeeping.ts).
create or replace function app.prune_session_rows(p_older_than interval)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  cutoff timestamptz;
  n_tokens integer;
  n_sessions integer;
  n_unlocks integer;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'session retention horizon must be at least one day' using errcode = '22023';
  end if;
  cutoff := now() - p_older_than;

  delete from private.child_refresh_tokens t
   using public.child_sessions s
   where t.session_id = s.id
     and least(s.expires_at, coalesce(s.revoked_at, s.expires_at)) < cutoff;
  get diagnostics n_tokens = row_count;

  delete from public.child_sessions s
   where least(s.expires_at, coalesce(s.revoked_at, s.expires_at)) < cutoff;
  get diagnostics n_sessions = row_count;

  delete from private.adult_unlocks u
   where least(u.expires_at, coalesce(u.revoked_at, u.expires_at)) < cutoff;
  get diagnostics n_unlocks = row_count;

  return n_tokens + n_sessions + n_unlocks;
end
$$;

revoke execute on function app.prune_session_rows(interval) from public, anon, authenticated, pl_child;
grant execute on function app.prune_session_rows(interval) to service_role;

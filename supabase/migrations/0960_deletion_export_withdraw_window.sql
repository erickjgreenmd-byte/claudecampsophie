-- 0960: a deletion also settles the exports that are still BEING BUILT, on both writers (HUNT7-D-1,
-- HUNT7-D-4).
--
-- 0920 moved the export withdrawal into `public.request_deletion` because the function is granted to
-- `authenticated`, so the Supabase Data API can file a deletion with a parent's own token and never
-- reach the Hono handler (the BUG-240 class, L-037 — the same reason 0890 moved the paid-slot release
-- inside it). It withdrew the rows that were ALREADY 'ready' and left the 'queued' ones, with this
-- justification, repeated in three places (0920:29-30, 0920:119-120, 0930:153-154):
--
--     "A 'queued' export is untouched: the builder leaves out every child with an open deletion
--      request (privacy.ts)."
--
-- THAT SENTENCE IS FALSE, in three separate ways, and it is why 0920 re-opened the window it was
-- written to close:
--
--   1. The check is not in privacy.ts. It is `childrenBeingDeleted` in
--      apps/api/src/jobs/export-build.ts, and it is an ordinary SELECT inside the BUILD transaction
--      under READ COMMITTED, taken BEFORE the file is composed. A deletion that commits after that
--      statement leaves the excluded-children array empty, so the deleted child's child_profiles,
--      assignments, extracted_questions (prompt_text, student_answer_text, corrected_*),
--      question_results, attempts, points_ledger, child_feedback and safety_reports rows all go into
--      the file.
--   2. It covers CHILD scope only: `childrenBeingDeleted` requires `target_child_id is not null`, so
--      for a family-scope request it returns nothing at all. The only family-scope guard on that path
--      is the handler's `join public.families f on f.deleted_at is null`, taken once before the build.
--   3. Nothing then stopped the row from becoming downloadable. The builder's settle is a
--      compare-and-set whose ONLY guard was `status = 'queued'` — the status this function had
--      deliberately left standing — so the row flipped to 'ready' with a live storage_path and a
--      seven-day expiry AFTER the deletion request, and apps/api/src/routes/export-download.ts
--      (which reads kind, status, storage_path and expires_at and nothing about deletion) minted a
--      signed URL for it. On a CHILD-scope request the family is live and the caller's membership is
--      active, and `assertRecentUnlock` is satisfied by the very unlock this function required, so
--      the parent who asked PencilLift to delete their child's data could download that child's
--      homework for seven days. The window closed only when the deletion_purge job deleted the row:
--      one job tick in normal operation, unbounded if that job dead-lettered. Word for word the
--      residual 0920's own header says it was written to remove.
--
-- THE FIX, in the two places the effect has to hold (L-037):
--   * HERE: the queued rows this function can judge without reading any file are settled to 'failed'
--     in the same transaction as the request, so the builder's `where id = .. and status = 'queued'`
--     matches nothing and the file can never become downloadable. That is EVERY queued row on a
--     family deletion, and the deleted child's own queued exports on a child deletion. The FUNCTION
--     carries it, not only the builder, because the Data API reaches the function directly — which is
--     the whole reason 0890 moved the slot release inside it.
--   * apps/api/src/jobs/export-build.ts: the settle refuses to publish (marks the row failed and
--     removes the object it just uploaded) when a deletion request is open that the file could NOT
--     have honoured — any family-scope request, or a child-scope one whose target is absent from the
--     snapshot the bytes were composed from. Belt and braces for any writer of
--     public.deletion_requests that is not one of these two functions, and the precise half: a
--     FAMILY-WIDE queued export on a child-scope deletion is left for it, because whether that file
--     is safe depends on what it contains and only the builder knows. See the statement below.
--
-- 'failed', not 'expired': the row never had a file, so "the link lapsed" would be a false statement
-- to the parent, `purgeExpiredExports` (which reads 'ready' rows) is not the thing that should close
-- it, and 'failed' is already what the builder and `settleDeadLetteredExport` write for a build that
-- will not produce a file — so the parent's export list says it could not be prepared, which is true.
-- The trade is deliberate: a family-wide export that was mid-build is lost and must be asked for
-- again, and the fresh build then leaves the deleted child out. The alternative is the download above.
-- apps/api/src/jobs/dispatcher.ts removes the deterministic `exports/{family}/{id}.{ext}` paths of
-- every non-'ready' row and schedules the second pass for them, so a file a still-running builder
-- uploads after the purge is still removed.
--
-- HUNT7-D-4: `app.inactivity_delete_family` is the OTHER writer of a family-scope
-- public.deletion_requests row, and 0920's L-037 sweep stopped at `public.request_deletion` without
-- saying whether it had been considered. It had no `public.data_exports` statement at all, so the
-- same two residuals lived on that path. It gets the same withdrawal, with one difference that
-- matters: the instant is the caller's STATED clock (p_now), not `now()`. That function is driven by
-- the jobs tick, whose clock is the application's, and a date comparison on an unstated clock is a
-- defect this project has now paid for twice (BUG-090, and the job-retention step of this round).
-- `public.request_deletion` keeps `now()`: it runs inside the parent's own request transaction, where
-- every other statement in the function already uses it, and 0780's pencillift.request_now exists for
-- the enqueued job's run_after rather than for the request's own writes.
--
-- Why the family-scope arm of the withdrawal is kept at all — the reason 0920:41-44 and 0930:67-69
-- gave is FALSE and is corrected in those files (HUNT7-D-4). No adult of a tombstoned family can
-- reach GET /v1/exports/:id/download: apps/api/src/routes/export-download.ts resolves
-- `currentFamilyId(c)` BEFORE it reads public.data_exports, and that resolves an ACTIVE
-- public.family_memberships row, every one of which both family-scope writers revoke in the same
-- transaction. The arm is kept as symmetry with the handler's `withdrawExports` and as defence in
-- depth against a future reader of data_exports that does not resolve an active membership first.
--
-- Regenerated from 0930_deletion_lock_order.sql (latest definition of public.request_deletion) and
-- 0840_hardening_r1_db.sql (latest definition of app.inactivity_delete_family). The lock order 0930
-- settled is unchanged: the family row (by the FK key share of the deletion_requests insert), then
-- public.child_slot_assignments, then public.child_profiles. public.data_exports keeps its place
-- after both, as 0920 put it.
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
  -- Same rule as the API (routes/privacy.ts): only the owner may delete the whole family; any
  -- guardian may delete a child's data. Enforced here too because this function is callable with
  -- the parent's own JWT (RV-privacy-1: database permissions, not only the API, decide).
  if p_child is null and not app.is_family_owner(p_family) then
    raise exception 'only the family owner can delete the family' using errcode = '42501';
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
  -- A scan already running for this family/child stops at its next compare-and-set or write
  -- checkpoint (spec P4: deletion stops processing immediately; RV-lead-jobs-ai-3).
  --
  -- HUNT7-D-1: this statement is NOT what stops a family-wide export_build job, and the 'queued'
  -- data_exports statement below is not redundant with it. A family-wide export_build job carries
  -- child_id NULL (routes/privacy.ts inserts the request's childId, null for kind 'family_data'), so
  -- on a CHILD-scope request `child_id = p_child` is NULL and the job is not cancelled; a job already
  -- leased by a worker is 'running' and is not cancelled on either scope.
  update public.assignments set status = 'deleted'
   where family_id = p_family and status <> 'deleted' and (p_child is null or child_id = p_child);
  if p_child is null then
    update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
    -- The adults are released with the tombstone, not by the later purge (DB-R1-02): the family is
    -- already invisible to them, and a still-active membership only blocked a fresh start. This is
    -- also what makes the export DOWNLOAD unreachable on this scope: export-download.ts resolves
    -- currentFamilyId from an active membership before it reads public.data_exports.
    update public.family_memberships set status = 'revoked', revoked_at = now()
     where family_id = p_family and status = 'active';
  else
    -- HUNT5-B-2: the paid slot is freed HERE, with the archive, so every surface that can file a
    -- request frees it — not only the API handler that ran the extra statement.
    --
    -- HUNT6-B-3: the assignment comes BEFORE the profile, which is the order every other writer of
    -- this pair uses. 0890 had them the other way round.
    update public.child_slot_assignments
       set released_at = now(), release_reason = 'archived'
     where family_id = p_family and child_id = p_child and released_at is null;
    update public.child_profiles set status = 'archived', archived_at = now() where id = p_child;
  end if;

  -- HUNT6-B-2: the finished export FILES that hold the deleted data are withdrawn here too, for the
  -- same reason the slot release moved in — `withdrawExports` lived only in the Hono handler while
  -- this function is callable with a parent's own token. Marking the row 'expired' is what makes
  -- apps/api/src/routes/export-download.ts refuse it (it reads status, storage_path and expires_at
  -- and nothing about deletion), so this is the half that must hold on every surface. The
  -- storage_path is deliberately LEFT standing: removing the object is the handler's half and the
  -- purge job's, and a row that still names its file can still be cleaned up later.
  --
  -- Scope matches the handler: all of the family's finished exports for a family deletion; for a
  -- child deletion, that child's exports and every family-wide export (child_id null — family data
  -- and progress files list every child).
  --
  -- The predicate is `status = 'ready'` alone, which is narrower than the handler's copy by one arm:
  -- an already-'expired' row that still names a file. That arm belongs to the handler, because there
  -- `returning id, storage_path` is what feeds the object removal and such a file must still go.
  -- HERE the statement has no `returning` and feeds nothing, and a row that is already 'expired' is
  -- already refused by export-download.ts on its status, so the arm would change no column, withdraw
  -- nothing more, and only take a row lock and write back a row version identical to the one it read.
  -- It is left out: this half is the STATUS, and that row's status is already right.
  update public.data_exports
     set status = 'expired',
         expires_at = least(coalesce(expires_at, now()), now())
   where family_id = p_family
     and status = 'ready'
     and (p_child is null or child_id = p_child or child_id is null);

  -- HUNT7-D-1: and the rows still BEING BUILT, in the same transaction as the request. Without this
  -- the builder's own compare-and-set (`set status = 'ready', storage_path = .., expires_at = ..
  -- where id = .. and status = 'queued'`, apps/api/src/jobs/export-build.ts) published a file composed
  -- from a snapshot taken BEFORE this request committed — see the header: the builder's deletion check
  -- is a plain SELECT under READ COMMITTED, and for family scope it checked nothing at all. 'failed' is
  -- the status for a build that will not produce a file, so this row can never satisfy
  -- export-download.ts and the parent's list does not claim a lapsed link that never existed.
  --
  -- SCOPE, and the one arm this deliberately does NOT take. On a family deletion (p_child is null)
  -- every queued row goes: nothing of this family is deliverable. On a CHILD deletion only that
  -- child's own queued exports go. A FAMILY-WIDE queued export (child_id is null) is LEFT ALONE, and
  -- that is not the false justification 0920 gave — it is a division of labour with the builder, which
  -- is the only party that knows what the bytes contain:
  --
  --   * If the build had not composed yet, it reads this request and leaves the child out, so the file
  --     is correct and the family keeps an export they asked for and are entitled to. Failing it here
  --     would destroy that file for every parent who had a family export in flight, which is the case
  --     spec P4 states explicitly (apps/api/tests/export-build.test.ts: on a child-scope deletion the
  --     family-wide file stays deliverable, carrying the sibling and not the deleted child).
  --   * If the build had ALREADY composed, the file holds the deleted child's rows and must not be
  --     published — and the builder refuses it, because its settle compares the requests open at
  --     publish time against the snapshot the bytes were composed from (`built.excludedChildren`) and
  --     a request missing from that snapshot fails the row.
  --
  -- This statement cannot tell those two apart; the builder can. Taking the broad arm here would trade
  -- a precise refusal for a blunt one and lose the good case, so the narrow scope is deliberate and the
  -- builder carries the rest. A family-scope request needs no such care: its first arm takes every row.
  --
  -- The asymmetry with the 'ready' statement just above — which DOES take `or child_id is null` — is
  -- deliberate and is not an oversight to tidy up. A 'ready' family-wide file was composed before this
  -- request existed, so it certainly holds the deleted child's rows and must be withdrawn. A 'queued'
  -- one may not have been composed at all. Same scope words, different facts.
  update public.data_exports
     set status = 'failed'
   where family_id = p_family
     and status = 'queued'
     and (p_child is null or child_id = p_child);

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

-- Regenerated from 0840_hardening_r1_db.sql (latest definition). ONLY change: the export withdrawal
-- (HUNT7-D-4), both halves, at the instant the caller stated.
create or replace function app.inactivity_delete_family(
  p_family uuid, p_now timestamptz, p_idle_before timestamptz, p_notice_before timestamptz)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  fam public.families;
  req public.deletion_requests;
  last_active timestamptz;
begin
  select * into fam from public.families where id = p_family for update;
  if not found or fam.deleted_at is not null or fam.inactivity_notified_at is null then
    return null;
  end if;
  select greatest(
           fam.created_at,
           coalesce((select max(m.last_seen_at) from public.family_memberships m where m.family_id = p_family), fam.created_at),
           coalesce((select max(a.created_at) from public.assignments a where a.family_id = p_family), fam.created_at),
           coalesce((select max(t.created_at) from public.attempts t where t.family_id = p_family), fam.created_at))
    into last_active;
  if last_active >= p_idle_before
     or fam.inactivity_notified_at <= last_active
     or fam.inactivity_notified_at >= p_notice_before then
    return null;
  end if;
  -- A family still paying for a subscription is never deleted for inactivity (store billing keeps
  -- charging; deletion must not surprise-cancel or imply a cancellation; RV-lead-jobs-ai-13).
  if app.family_may_be_charged(p_family, p_now) then
    return null;
  end if;

  insert into public.deletion_requests (family_id, scope, requested_by)
    values (p_family, 'family', fam.created_by)
    returning * into req;
  update public.child_sessions set revoked_at = now(), revoke_reason = 'deletion'
   where family_id = p_family and revoked_at is null;
  update public.child_devices set revoked_at = now() where family_id = p_family and revoked_at is null;
  update public.jobs set status = 'cancelled', updated_at = now()
   where family_id = p_family and status in ('queued', 'failed_retryable');
  update public.assignments set status = 'deleted' where family_id = p_family and status <> 'deleted';
  update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
  -- The adults are released with the tombstone, not by the later purge (DB-R1-02).
  update public.family_memberships set status = 'revoked', revoked_at = now()
   where family_id = p_family and status = 'active';
  -- HUNT7-D-4: the same two export statements public.request_deletion runs, because this is the
  -- other writer of a family-scope deletion_requests row and L-037 asks for the effect on every
  -- surface that files the action. The instant is p_now — the clock the TICK stated — and not now():
  -- this function's caller is apps/api/src/jobs/dispatcher.ts, whose clock is the application's, and
  -- an instant comparison on an unstated clock is the BUG-090 shape.
  update public.data_exports
     set status = 'expired',
         expires_at = least(coalesce(expires_at, p_now), p_now)
   where family_id = p_family and status = 'ready';
  update public.data_exports set status = 'failed'
   where family_id = p_family and status = 'queued';
  insert into public.jobs (kind, idempotency_key, family_id, payload)
    values ('deletion_purge', 'deletion:' || req.id::text, p_family,
            jsonb_build_object('deletionRequestId', req.id, 'reason', 'inactivity'));
  insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
    values (p_family, 'system', 'deletion.inactivity', 'family', p_family::text);
  return req.id;
end
$$;

revoke execute on function app.inactivity_delete_family(uuid, timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated, pl_child;
grant execute on function app.inactivity_delete_family(uuid, timestamptz, timestamptz, timestamptz)
  to service_role;

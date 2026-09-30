-- 0930: request_deletion takes a family's slot assignment before its child profile (HUNT6-B-3).
--
-- BUG-106 and FL-R4-02 settled that every writer of a family's rows takes them in ONE order. 0890
-- added a writer that did not. Its child branch updates public.child_profiles and THEN
-- public.child_slot_assignments; every other writer of that pair goes the other way:
--   * apps/api/src/routes/family.ts's archive route — lockFamily (families `for update`), then the
--     open assignment, then the profile;
--   * apps/api/src/services/billing-sync.ts — applyCapacity releases the excess assignments, then
--     releaseSlotlessProfiles moves those children back to 'draft';
--   * the purges — app.purge_family_data (0620) and its successors (0710, 0820) take the family row
--     `for update`, then delete the assignments, then the profiles.
--
-- THE CANONICAL ORDER IS: the family row, then public.child_slot_assignments, then
-- public.child_profiles. It is canonical because it is the archive route's, which is the oldest and
-- the most-used writer of the pair and the one BUG-106's sweep recorded ("their writers take the
-- family row first"); moving one statement in this function is also the smaller change, and the two
-- statements are independent, so their order carries no meaning of its own.
--
-- WHAT THE INVERSION COST: nothing that was reachable, and this file said otherwise. It claimed the
-- store's downgrade webhook "takes no family `for update` at all" and rested the whole rationale on
-- that. It is FALSE, and whoever next changes this order must not inherit it. EVERY production writer
-- of the pair holds that row `for update` before it touches either child row:
--   * the archive route — lockFamily in apps/api/src/routes/family.ts;
--   * every billing writer — reconcileFamilyBilling owns both applyCapacity's release and
--     releaseSlotlessProfiles and states the precondition itself ("Must run inside a transaction that
--     already holds the family row lock", apps/api/src/services/billing-sync.ts), and all three of its
--     callers meet it with `select ... from public.families ... for update`: lockLiveFamily on the
--     RevenueCat webhook (apps/api/src/routes/webhooks.ts), POST /v1/billing/sync
--     (apps/api/src/routes/billing.ts) and syncFamilyFromProvider for the billing tick;
--   * the purges, as above.
-- And this function's FIRST statement — `insert into public.deletion_requests` — needs a KEY SHARE on
-- that same family row for its foreign key, which FOR UPDATE conflicts with. So whichever of the two
-- arrives first, the other blocks before it has written any child row: a concurrent deletion waits
-- with nothing but deletion_requests written, whatever order its child statements are in, and a
-- writer arriving second blocks on its own first statement. No cycle, in either direction, against
-- either candidate. supabase/tests/hardening_r5_db.test.ts pins it for the billing path and for the
-- archive route alike: the blocked backend's only granted RowExclusiveLock is on deletion_requests,
-- and both transactions commit.
--
-- SO 0930 IS A DEFENSIVE ORDERING, not the repair of a reachable deadlock, and this is what it
-- defends against — a shape the tree already contains half of. A transaction that reaches the family
-- row in a mode that does NOT conflict with FOR KEY SHARE lets this function straight through to the
-- child rows. `for no key update` is such a mode, and lockFamily(.., 'no-key-update')
-- (apps/api/src/routes/family.ts, the pairing-code route) takes it on purpose, so the child pairing
-- REDEEM path's own FK locks are not blocked in turn. That route locks public.child_profiles and
-- never writes public.child_slot_assignments, so it closes no cycle and no deadlock is reachable
-- today. A writer of the same shape that also released the slot WOULD close one against 0890's order,
-- and Postgres would abort one of the two with SQLSTATE 40P01 — the 503 "The service is busy. Please
-- try again." BUG-106 and FL-R4-02 were filed for, with a purge that never started leaving the
-- deletion request at 'requested'. The third case in hardening_r5_db.test.ts is exactly that writer,
-- labelled as the synthetic writer it is, and it deadlocks if these two statements are swapped back.
--
-- No new lock is taken. An explicit `perform 1 from public.families ... for update` would also serve,
-- but the family row is already this function's first lock (the FK above), and one order for the two
-- child rows is what was missing.
--
-- Regenerated from 0920_deletion_export_withdraw.sql (latest definition). ONLY change: the child
-- branch's two statements are swapped.
--
-- `release_reason` is 'archived': the reason the archive route and the API statement use and the
-- status the child now has. A distinct 'deletion' value would need the release_reason check
-- constraint widened (0200_billing.sql), which is not this migration's to change.
--
-- Only a CHILD-scope request needs the SLOT RELEASE. A family-scope request tombstones the family
-- and revokes every membership in the same transaction, so no route reads that family's capacity
-- again and no sibling can be blocked; the purge deletes the assignment rows with the rest (0620).
-- The export withdrawal is NOT like that and runs for both scopes: a tombstoned family's adults keep
-- a readable deletion state (0840) and the download route reads only data_exports, so a family-scope
-- request must expire those rows as well.
--
-- Lock order, stated as a claim about every writer of these rows rather than about one trigger:
--   * app.enforce_slot_capacity never contends with the release, because the release sets released_at
--     to a non-null value and the trigger returns at 0200_billing.sql's
--     `if new.released_at is not null` before reaching its `perform 1 from public.families ... for
--     update`.
--   * Every writer of this pair takes the FAMILY ROW first, and that — not a shared statement order —
--     is what rules out a cycle. The archive route, the billing writers and the purges take it FOR
--     UPDATE; this function's own first lock on it is the KEY SHARE that `insert into
--     public.deletion_requests` needs for its foreign key, which their FOR UPDATE conflicts with. So
--     no cycle exists among the writers of this pair, by either route.
--   * Within the pair they do agree: assignment, then profile.
--
-- HUNT7-D-2 corrects this comment. It used to say those writers "now agree with this function
-- statement for statement", and that is FALSE outside the pair, in three places:
--   (a) the archive route (POST /v1/children/:id/archive in apps/api/src/routes/family.ts) writes, in
--       this order: child_slot_assignments, child_profiles, child_sessions, child_devices,
--       audit_events — the session and device rows AFTER the pair. This function writes child_sessions
--       and child_devices BEFORE the pair (they are its second and third statements, right after the
--       deletion_requests insert). For {child_profiles, child_sessions} and for
--       {child_slot_assignments, child_sessions} the two writers are inverted.
--   (b) app.purge_family_data (0820_support_cases_purge.sql) deletes child_slot_assignments at a
--       different point in its sequence, so its order does not match statement for statement either.
--   (c) public.data_exports is written near the end here and is not written by the archive route at all.
-- (Statements, not line numbers: line numbers in a comment rot at the next edit — this correction's own
-- first draft cited four of them and three were already stale by the time it was written.)
-- None of that is reachable as a deadlock today, precisely because of the first bullet: every one of
-- these writers serialises on the family row before it touches any of these tables, so two of them
-- never hold one of these row locks concurrently. The claim that mattered is the family-row one; the
-- statement-for-statement claim was decoration, and decoration that would have told the next author
-- they could add a writer WITHOUT taking the family row as long as they copied this function's
-- sequence. They cannot. A new writer of any of these tables takes the family row first, or it has to
-- re-derive this argument from scratch.
-- The release also cannot flip the child back to a draft: billing's releaseSlotlessProfiles only
-- touches `status = 'active'` rows whose latest release_reason is 'expired' or 'downgrade', and this
-- child is 'archived' with reason 'archived'.
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
  update public.assignments set status = 'deleted'
   where family_id = p_family and status <> 'deleted' and (p_child is null or child_id = p_child);
  if p_child is null then
    update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
    -- The adults are released with the tombstone, not by the later purge (DB-R1-02): the family is
    -- already invisible to them, and a still-active membership only blocked a fresh start.
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
  -- and progress files list every child). A 'queued' row is left alone because the builder already
  -- leaves out every child with an open deletion request.
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

-- 0920: a deletion withdraws the family's finished exports in the database (HUNT6-B-2).
--
-- Migration 0890 exists because `public.request_deletion` is granted to `authenticated`
-- (0840_hardening_r1_db.sql), so the Supabase Data API can call it with a parent's own access token
-- and its gates — app.is_family_member plus app.has_recent_adult_unlock() — are satisfiable from
-- there. 0890 moved ONE effect that lived only in the Hono handler into the function (the paid-slot
-- release) and left the other: `withdrawExports` (apps/api/src/routes/privacy.ts) is still invoked
-- after the RPC, from the handler alone.
--
-- So a child-scope request filed through the Data API — which, unlike a family-scope one, leaves the
-- family live and the caller's membership active — archived the child, revoked its sessions and
-- enqueued the purge while every FINISHED export stayed at status 'ready' with its storage_path.
-- apps/api/src/routes/export-download.ts refuses only a non-ready row, a missing path or a lapsed
-- expiry and reads nothing about deletion, so GET /v1/exports/:id/download kept minting signed URLs
-- for a family_data or progress file holding that child's homework, transcriptions, results and
-- safety-notice rows. The only thing that ended it was the deletion_purge job removing the objects,
-- so the window was until the next job tick in normal operation and unbounded if that job
-- dead-lettered. Meanwhile privacy.ts asserted the property with no qualifier: "a deletion withdraws
-- every finished export file that holds the deleted data as soon as it is requested". This is the
-- BUG-240 class again (L-037: the same effect on EVERY surface that offers the action), and it is
-- 0890's own class, so the backstop belongs here.
--
-- Regenerated from 0890_deletion_slot_release.sql (latest definition). ONLY change: the finished
-- exports are withdrawn, for both scopes, in the same transaction as the request. The handler's
-- `withdrawExports` stays as an idempotent belt-and-braces AND as the half that removes the files
-- from private storage, which SQL cannot do; the purge job removes them too.
--
-- The status is the half that makes the download route refuse; storage_path is deliberately left
-- standing so the file-removing halves still have a path to delete. A 'queued' export is untouched:
-- the builder leaves out every child with an open deletion request (privacy.ts), so expiring a row
-- that has no file yet would only lose the parent their pending copy.
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
-- The slot-release UPDATE cannot deadlock against app.enforce_slot_capacity's family lock: it sets
-- released_at to a non-null value, so the trigger returns at 0200_billing.sql's
-- `if new.released_at is not null` before reaching its `perform 1 from public.families ... for
-- update`. That is a claim about the TRIGGER only; the order in which this function takes
-- public.child_slot_assignments and public.child_profiles relative to the other writers of that pair
-- is 0930_deletion_lock_order.sql's subject and is still inverted here. The release also cannot flip
-- the child back to a draft: billing's releaseSlotlessProfiles only touches `status = 'active'` rows
-- whose latest release_reason is 'expired' or 'downgrade', and this child is 'archived' with reason
-- 'archived'.
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
    update public.child_profiles set status = 'archived', archived_at = now() where id = p_child;
    -- HUNT5-B-2: the paid slot is freed HERE, with the archive, so every surface that can file a
    -- request frees it — not only the API handler that ran the extra statement.
    update public.child_slot_assignments
       set released_at = now(), release_reason = 'archived'
     where family_id = p_family and child_id = p_child and released_at is null;
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

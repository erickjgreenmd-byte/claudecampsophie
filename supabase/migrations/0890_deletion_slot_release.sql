-- 0890: a child deletion frees that child's paid slot in the database (HUNT5-B-2, FL-R4-01).
--
-- FL-R4-01 freed the slot in the API handler (apps/api/src/routes/privacy.ts releaseChildSlot),
-- one statement after the RPC and inside the same transaction. That is correct for the handler and
-- insufficient for the product: `public.request_deletion` is granted to `authenticated`
-- (0840_hardening_r1_db.sql), so the Supabase Data API can reach it with a parent's own access
-- token (docs/Architecture.md treats the Data API as a live client surface), and its gates —
-- app.is_family_member plus app.has_recent_adult_unlock() — are satisfiable from there. A call that
-- did not go through that one handler archived the child, revoked its sessions and enqueued the
-- purge while the paid slot stayed assigned: the family kept paying for a slot held by a child whose
-- data was being erased, activating a sibling answered NEEDS_PAID_SLOT ("All 1 paid child slots are
-- in use. Add a child slot to your plan first."), and no route could free it again. This is the
-- BUG-240 class (L-037: the same pre-check must hold on EVERY surface that offers the action), so
-- the backstop belongs here.
--
-- Regenerated from 0840_hardening_r1_db.sql (latest definition). ONLY change: the child branch also
-- releases that child's open slot assignment, in the same transaction as the archive. The API
-- statement stays as an idempotent belt-and-braces (it matches `released_at is null`, which this
-- has already made false).
--
-- `release_reason` is 'archived': the reason the archive route and the API statement use and the
-- status the child now has. A distinct 'deletion' value would need the release_reason check
-- constraint widened (0200_billing.sql), which is not this migration's to change.
--
-- Only a CHILD-scope request needs this. A family-scope request tombstones the family and revokes
-- every membership in the same transaction, so no route reads that family's capacity again and no
-- sibling can be blocked; the purge deletes the assignment rows with the rest (0620).
--
-- The UPDATE cannot deadlock against app.enforce_slot_capacity's family lock: it sets released_at
-- to a non-null value, so the trigger returns at 0200_billing.sql's `if new.released_at is not null`
-- before reaching its `perform 1 from public.families ... for update`. It also cannot flip the child
-- back to a draft: billing's releaseSlotlessProfiles only touches `status = 'active'` rows whose
-- latest release_reason is 'expired' or 'downgrade', and this child is 'archived' with reason
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

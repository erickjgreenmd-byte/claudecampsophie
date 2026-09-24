-- 0680_retention.sql
-- Inactivity retention (spec P4: explicit inactivity period, parent notice, tested deletion).
-- The mechanism ships disabled (API flag INACTIVITY_DELETION_ENABLED) until the owner approves the
-- period; 12 months is the spec's proposal, not an approved policy (docs/Owner_Actions.md).

-- Parent activity: the API stamps this at most once a day per adult (reads count as activity).
alter table public.family_memberships add column last_seen_at timestamptz;

-- When the inactivity notice was sent; any later activity clears it.
alter table public.families add column inactivity_notified_at timestamptz;

-- Service-only tombstone for an inactive family whose notice period has passed. Mirrors
-- request_deletion: tombstone, stop work, revoke sessions and enqueue the purge in one transaction.
create or replace function app.inactivity_delete_family(p_family uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  fam public.families;
  req public.deletion_requests;
begin
  select * into fam from public.families where id = p_family for update;
  if not found or fam.deleted_at is not null then
    return null;
  end if;
  if fam.inactivity_notified_at is null then
    raise exception 'inactivity notice required before deletion' using errcode = 'P0001';
  end if;

  insert into public.deletion_requests (family_id, scope, requested_by)
    values (p_family, 'family', fam.created_by)
    returning * into req;
  update public.child_sessions set revoked_at = now(), revoke_reason = 'deletion'
   where family_id = p_family and revoked_at is null;
  update public.child_devices set revoked_at = now() where family_id = p_family and revoked_at is null;
  update public.jobs set status = 'cancelled', updated_at = now()
   where family_id = p_family and status in ('queued', 'failed_retryable');
  update public.families set deletion_requested_at = now(), deleted_at = now() where id = p_family;
  insert into public.jobs (kind, idempotency_key, family_id, payload)
    values ('deletion_purge', 'deletion:' || req.id::text, p_family,
            jsonb_build_object('deletionRequestId', req.id, 'reason', 'inactivity'));
  insert into public.audit_events (family_id, actor_kind, action, target_type, target_id)
    values (p_family, 'system', 'deletion.inactivity', 'family', p_family::text);
  return req.id;
end
$$;

revoke execute on function app.inactivity_delete_family(uuid) from public, anon, authenticated, pl_child;
grant execute on function app.inactivity_delete_family(uuid) to service_role;

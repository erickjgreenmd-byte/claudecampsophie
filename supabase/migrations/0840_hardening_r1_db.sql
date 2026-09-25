-- 0840_hardening_r1_db.sql
-- Hardening round 1, database findings DB-R1-01..04 (docs/Bug_Ledger.md).
--   1. DB-R1-01: public.jobs had only the partial jobs_ready index and the idempotency_key unique
--      index, and nothing ever pruned terminal rows, so every child practice/review status read,
--      every scan submission and the dispatcher's lease recovery seq-scanned the whole ledger.
--      Two indexes plus app.prune_terminal_jobs(interval) for a retention step in the tick.
--   2. DB-R1-02: a family-data deletion left the adults' memberships 'active' on the tombstoned
--      family until the purge job ran, so create_family answered "adult already belongs to a
--      family" meanwhile (indefinitely if the purge dead-lettered). public.request_deletion (family
--      scope) and app.inactivity_delete_family now release the memberships in the same transaction
--      as the tombstone. Both are regenerated from their latest definitions in
--      0710_jobs_hardening.sql (L-026; the only lines added are the membership release).
--      app.purge_family_data (0820) keeps its later revoke, which is now a no-op.
--   3. DB-R1-03: pg_timezone_names lists pseudo-zones ('localtime', 'Factory', 'posixrules', and
--      'posix/*' / 'right/*' on builds that ship them) that Intl.DateTimeFormat rejects, and
--      app.families_require_iana_timezone() accepted them through the PostgREST column grant. They
--      leave the private.known_time_zones cache and the guard refuses them on the live view too.
--      The trigger function is regenerated from 0720_identity_hardening.sql (L-026).
--   4. DB-R1-04: public.safety_reports had no family index; the parent's safety-report list scanned
--      every family's reports.

-- ---------------------------------------------------------------------------------------------
-- 1. Job ledger indexes and retention (DB-R1-01)
-- ---------------------------------------------------------------------------------------------

-- Serves the per-family/child status lookups on rows of every status:
--   apps/api/src/routes/learning.ts GET /child/practice/today
--     (kind = 'daily_set_generate' and child_id = .. and family_id = .. order by created_at desc),
--   learning.ts GET /child/reviews/current (kind = 'thursday_review_generate', same shape),
--   apps/api/src/routes/homework.ts and privacy.ts scan-version counts
--     (family_id = .. and idempotency_key like 'scan:<id>:v%'),
--   apps/api/src/routes/guardians.ts consent withdrawal cancel (family_id = .. and status in ..),
--   and the family/child purge (app.purge_family_data: family_id = .. and child_id = ..).
create index jobs_family_child on public.jobs (family_id, child_id, kind, created_at desc);

-- Serves the dispatcher's lease recovery (apps/api/src/jobs/dispatcher.ts runJobs:
-- where status = 'running' and locked_until < now), which otherwise scans every row.
create index jobs_running on public.jobs (locked_until) where status = 'running';

-- Retention for the ledger: deletes jobs that ended (succeeded, cancelled, dead-lettered) more than
-- p_older_than ago. Kept whatever their age: rows still in flight (queued, running,
-- failed_retryable), failed_final rows (an operator reads them), and the deletion_purge and
-- account_close rows, which are the audit trail that a deletion request and an account closure
-- were carried out (spec P4; 0830). updated_at is the instant a job reached its terminal state
-- (app.guard_job stamps it on every write). Returns the number of rows deleted. Service-only;
-- wired into the scheduled tick by the lead (apps/api/src/jobs/dispatcher.ts runScheduledTick).
create or replace function app.prune_terminal_jobs(p_older_than interval)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'job retention horizon must be at least one day' using errcode = '22023';
  end if;
  delete from public.jobs
   where status in ('succeeded', 'cancelled', 'dead_letter')
     and kind not in ('deletion_purge', 'account_close')
     and updated_at < app.request_instant() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke execute on function app.prune_terminal_jobs(interval) from public, anon, authenticated, pl_child;
grant execute on function app.prune_terminal_jobs(interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. A family deletion releases the adults at request time (DB-R1-02)
-- ---------------------------------------------------------------------------------------------

-- Regenerated from 0710_jobs_hardening.sql (latest definition). Only change: after the family
-- tombstone, every active membership of the family is revoked in the same transaction, so the
-- adults can start a new family at once (public.create_family and the unique index
-- family_memberships_one_active_family_per_user look at active memberships only). revoked_at
-- equals families.deletion_requested_at: a membership released by the deletion itself is
-- distinguishable from a guardian the owner removed earlier (revoked_at < deletion_requested_at).
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

-- Regenerated from 0710_jobs_hardening.sql (latest definition). Only change: the membership
-- release after the tombstone, as in request_deletion above.
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

-- ---------------------------------------------------------------------------------------------
-- 3. Pseudo-zones are not IANA zones (DB-R1-03)
-- ---------------------------------------------------------------------------------------------

-- pg_timezone_names carries entries that are not IANA zones: 'localtime' (the server's own zone
-- file), 'Factory' (the tz database placeholder), 'posixrules', and the 'posix/' and 'right/'
-- variants on builds that ship them. Intl.DateTimeFormat (packages/domain/src/scheduling/
-- local-time.ts) throws on these, so a family carrying one would break its own scheduling.
-- Postgres on the hosted project may have copied them into the cache (0720); they leave it here.
delete from private.known_time_zones
 where name in ('localtime', 'Factory', 'posixrules')
    or name like 'posix/%' or name like 'right/%';

-- Regenerated from 0720_identity_hardening.sql (latest definition). Only change: the pseudo-zone
-- exclusion, which also covers the live pg_timezone_names fallback.
create or replace function app.families_require_iana_timezone() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.timezone is null
     or new.timezone in ('localtime', 'Factory', 'posixrules')
     or new.timezone like 'posix/%' or new.timezone like 'right/%'
     or not (
       exists (select 1 from private.known_time_zones z where z.name = new.timezone)
       or exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone)
     ) then
    raise exception 'time zone is not a known IANA zone'
      using errcode = '23514', constraint = 'families_timezone_iana';
  end if;
  return new;
end
$$;

revoke execute on function app.families_require_iana_timezone() from public, anon, authenticated, pl_child;

-- ---------------------------------------------------------------------------------------------
-- 4. Safety reports by family (DB-R1-04)
-- ---------------------------------------------------------------------------------------------

-- Serves apps/api/src/routes/privacy.ts GET /safety-reports
-- (where family_id = .. order by created_at desc limit ..) and the child purge's
-- `where family_id = .. and child_id = any(..)` (app.purge_family_data).
create index safety_reports_family on public.safety_reports (family_id, created_at desc);

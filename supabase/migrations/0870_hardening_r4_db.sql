-- 0870_hardening_r4_db.sql
-- Hardening round 4, database findings HR4-0860-01 and HR4-0860-02 (docs/Bug_Ledger.md). Both are
-- gaps left by 0860's own sweeps, on 0860's own stated threat model: "one SQL-injection bug on a
-- path that runs as `authenticated`" (the API opens parent transactions with
-- `set local role authenticated`, apps/api/src/db.ts:54).
--   1. HR4-0860-01: 0860 section 2 revoked TRUNCATE/TRIGGER/REFERENCES on all public TABLES and in
--      the table default privileges, and stopped there. The Supabase default privileges also grant
--      ALL on SEQUENCES (supabase/tests/shim/supabase_platform_shim.sql:108), so anon and
--      authenticated held USAGE, SELECT and UPDATE on public.audit_events_id_seq,
--      public.ai_usage_events_id_seq and public.points_ledger_id_seq — the identity sequences of
--      exactly the three append-only ledgers 0860's header names as the evidence it protects.
--      UPDATE on a sequence is all setval() needs, and setval needs no privilege on the owning
--      table, so app.prevent_mutation() and the revoked INSERT/UPDATE/DELETE grants never saw it:
--      `select setval('public.audit_events_id_seq', 1, false)` as `authenticated` made every later
--      append fail on audit_events_pkey until an operator repaired the sequence, which stops
--      create_family, request_deletion (spec P4 "delete my data"), device pairing, activation and
--      consent, and on ai_usage_events_id_seq stops settleSpend's cost insert, leaving the spend
--      hold to hold the owner's AI budget to the end of the month
--      (apps/api/src/jobs/spend-ceiling.ts:265). 0640_monetization.sql:671 already applied this rule
--      to one sequence (`revoke all on sequence public.aggregate_ad_events_id_seq ...`); the newer
--      ledgers' sequences were never given the same treatment, and 0860 added a schema_invariants
--      case for tables with no sibling case for sequences.
--   2. HR4-0860-02: 0860 section 3b moved the archived-child / child-under-deletion rule into BEFORE
--      triggers, but created test_dates_data_api_guard `before insert` only, and public.test_dates
--      was the one table in the guarded set where `authenticated` held DELETE
--      (0100_learning.sql:499) under a `for all` policy. So a direct PostgREST DELETE with the
--      parent's own JWT removed an archived child's test dates — which the API's own
--      DELETE /children/:childId/test-dates/:testDateId refuses with CHILD_ARCHIVED
--      (apps/api/src/routes/learning.ts) — and did the same while a deletion request covering the
--      child was requested/processing, because request_deletion archives the target child
--      (0620_deletion_purge.sql:112). It is the only client DELETE in the set 0860 guards, so the
--      guard gains the `before delete` branch it was missing rather than the rule moving into an ACL.

-- ---------------------------------------------------------------------------------------------
-- 1. A sequence is not a client object either (HR4-0860-01)
-- ---------------------------------------------------------------------------------------------

-- Every sequence in public belongs to a `generated always as identity` column (audit_events,
-- ai_usage_events, points_ledger, aggregate_ad_events), and an identity column is advanced
-- internally and authorized on the table, so no insert of any role needs USAGE here. SELECT is
-- likewise nothing a client needs: last_value is bookkeeping. service_role keeps its privileges, as
-- it does for tables. supabase/tests/hardening_r2_db.test.ts pins the identity-only fact, so a
-- future `serial` column in public cannot quietly depend on a client USAGE grant.
revoke all on all sequences in schema public from anon, authenticated, pl_child;

-- New sequences must not receive them again. Per granting role, like the table entry 0860 cancelled;
-- supabase/tests/schema_invariants.test.ts fails on any public sequence where a client role holds a
-- privilege, so a hosted default privilege set by another role is caught in CI.
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. The one client DELETE in the guarded set is guarded too (HR4-0860-02)
-- ---------------------------------------------------------------------------------------------

-- The rule 0860 set out to enforce is about the row, not about who may issue a DELETE: an archived
-- profile is history only, and a child covered by an open deletion request has stopped (spec P4). So
-- the guard grows the branch it was missing, `before delete`, and it holds whatever grant
-- public.test_dates carries now or later. It is a separate function because
-- app.data_api_learning_write_guard() reads `new` throughout and `new` is not assigned on a DELETE.
--
-- Deliberately NOT a revoke of the DELETE grant: a revoke moves the enforcement into the ACL, which
-- is only as good as the next `grant all` (0100_learning.sql:499 is exactly that statement), and it
-- would make the archived rule depend on the API always choosing the service role. The DELETE grant
-- is still worth removing as defence in depth — this migration is what makes that a pure grant
-- change with no behaviour left riding on it. See the note to the lead in the round report:
-- supabase/tests/learning_runtime.test.ts:86 (another owner's file) deletes a test date as the
-- parent role and has to move to the service role in the same change as the revoke.
--
-- Like every 0860 guard this is SECURITY INVOKER and returns early for any role but `authenticated`,
-- because the purge (0620), the deletion worker and the jobs delete test dates of archived children
-- and children under deletion on purpose; app.assert_parent_child_write is SECURITY DEFINER, so the
-- checks read the authoritative rows rather than what RLS shows the caller.
create or replace function app.data_api_test_date_delete_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return old;
  end if;
  perform app.assert_parent_child_write(old.family_id, old.child_id);
  return old;
end
$$;

-- A trigger function needs no EXECUTE privilege to fire, and no client role may call it directly
-- (the same treatment as app.bump_schedule_version_on_test_date, pinned by
-- supabase/tests/learning_runtime.test.ts).
revoke execute on function app.data_api_test_date_delete_guard() from public, anon, authenticated, pl_child;

create trigger test_dates_data_api_delete_guard
  before delete on public.test_dates
  for each row execute function app.data_api_test_date_delete_guard();

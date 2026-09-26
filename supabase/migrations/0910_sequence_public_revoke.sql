-- 0910_sequence_public_revoke.sql
-- Hardening round 5, the residual of HR4-0860-01 (docs/Bug_Ledger.md): 0870 section 1 revoked the
-- sequence privileges of anon, authenticated and pl_child, and stopped at named roles. A privilege
-- held by PUBLIC is held by every role there is, the three included, so one
-- `grant all on all sequences in schema public to public` — or a hosted platform whose schema
-- default names PUBLIC rather than the two roles the CI shim names
-- (supabase/tests/shim/supabase_platform_shim.sql:108) — hands `authenticated` back exactly the
-- UPDATE that setval() needs, and neither revoke list in 0870 would touch it. That is the whole of
-- HR4-0860-01 again: `select setval('public.audit_events_id_seq', 1, false)` as `authenticated`
-- makes every later append fail on audit_events_pkey until an operator repairs the sequence, which
-- stops create_family, request_deletion (spec P4 "delete my data"), device pairing, activation and
-- consent; on public.ai_usage_events_id_seq it stops settleSpend's cost insert, leaving the spend
-- hold to hold the owner's AI budget to the end of the month (apps/api/src/jobs/spend-ceiling.ts).
--
-- supabase/tests/schema_invariants.test.ts now counts PUBLIC as a client role, but a CI invariant
-- reports the state after the fact. These two statements are what keeps the state from arising: the
-- deployed schema holds no PUBLIC privilege on any sequence in public, and a sequence created later
-- inherits none.
--
-- What a revoke does and does not do, stated plainly: it removes the privilege wherever it is held
-- now, including a grant made by an earlier migration or by the hosted platform before this schema
-- was deployed, and it cancels the schema default so new sequences do not receive it again. It
-- cannot stop a LATER `grant ... to public` written by a future migration — that is what the two
-- [HR4-0860-01] cases in supabase/tests/schema_invariants.test.ts are for.
--
-- 0870 is left exactly as it shipped; this is an additive second pass over the same objects with the
-- same two statement shapes, and applying it twice is a no-op
-- (supabase/tests/hardening_r2_db.test.ts pins both facts).

-- The shape of 0870:44, for the grantee it did not name. service_role keeps its privileges, as it
-- does for tables: every real ledger append runs as the service role or inside a SECURITY DEFINER
-- function, and every sequence in public belongs to a `generated always as identity` column, which
-- is advanced internally and authorized on the table rather than through a client's USAGE.
revoke all on all sequences in schema public from public;

-- The shape of 0870:49, for the grantee it did not name. Per granting role, like the table entry
-- 0860 cancelled.
alter default privileges in schema public revoke all on sequences from public;

-- 0750_reward_rules_settings.sql
-- Spec P9 "Provide configurable earning rules"; AC_REWARDS_01 ("Earned points, bonus rules and caps
-- match the published family rules; empty/rapid retries do not farm points"). Depends on 0001 and
-- 0400.
--
-- 0400 created public.reward_rules (suggested defaults 2/3/5 points, 1500 ms) but gave no one a way
-- to publish or change them: authenticated has no write grant and pl_child no read grant, so every
-- family earned on defaults it never saw. This migration adds
-- - public.parent_set_reward_rules: the only write path. Like parent_adjust_points it re-checks
--   family membership (owner or guardian) and a recent adult unlock inside the database, upserts
--   idempotently (saving the same values is a no-op) and audits each real change in the same
--   transaction. Rules apply to awards computed after the change; the append-only ledger keeps
--   every past award as it was (nothing is recomputed).
-- - a table-level anti-farming floor: min_meaningful_response_ms >= 500 (the domain's
--   MIN_RESPONSE_THRESHOLD_MS, which the answer route already clamps to), so no write path can
--   configure the rapid-guess protection away.
-- - a column-limited read for paired children: the three point values of their own family, never
--   the response threshold (a child told the exact threshold could simply wait it out).

-- The answer route has always applied max(500, stored value); align any stored value with what was
-- actually applied before the floor becomes a constraint.
update public.reward_rules set min_meaningful_response_ms = 500 where min_meaningful_response_ms < 500;

alter table public.reward_rules
  add constraint reward_rules_min_meaningful_floor check (min_meaningful_response_ms >= 500);

create or replace function public.parent_set_reward_rules(
  p_family uuid,
  p_attempt_points integer,
  p_independent_correct_bonus integer,
  p_set_completion_points integer,
  p_min_meaningful_response_ms integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := app.current_user_id();
  previous public.reward_rules;
  saved public.reward_rules;
begin
  if p_family is null or not app.is_family_member(p_family) then
    raise exception 'family not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  -- Same limits as the table checks, @pencillift/domain/rewards validateRules and the API contract.
  if p_attempt_points is null or p_attempt_points not between 0 and 100
     or p_independent_correct_bonus is null or p_independent_correct_bonus not between 0 and 100
     or p_set_completion_points is null or p_set_completion_points not between 0 and 100 then
    raise exception 'reward points must be whole numbers from 0 to 100' using errcode = '22023';
  end if;
  if p_min_meaningful_response_ms is null
     or p_min_meaningful_response_ms not between 500 and 60000 then
    raise exception 'minimum response time must be from 500 to 60000 ms' using errcode = '22023';
  end if;

  -- Lock the current rules (when the family has saved any) so the audited "before" is exact.
  select * into previous from public.reward_rules where family_id = p_family for update;
  insert into public.reward_rules as r
      (family_id, attempt_points, independent_correct_bonus, set_completion_points, min_meaningful_response_ms)
    values (p_family, p_attempt_points, p_independent_correct_bonus, p_set_completion_points,
            p_min_meaningful_response_ms)
    on conflict (family_id) do update
      set attempt_points = excluded.attempt_points,
          independent_correct_bonus = excluded.independent_correct_bonus,
          set_completion_points = excluded.set_completion_points,
          min_meaningful_response_ms = excluded.min_meaningful_response_ms,
          updated_at = now()
      where (r.attempt_points, r.independent_correct_bonus, r.set_completion_points, r.min_meaningful_response_ms)
            is distinct from
            (excluded.attempt_points, excluded.independent_correct_bonus, excluded.set_completion_points,
             excluded.min_meaningful_response_ms)
    returning * into saved;
  if not found then
    return false; -- identical to the published rules: idempotent retry, nothing to audit
  end if;

  -- Rule values only (family settings, never child content).
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id, metadata)
    values (p_family, uid, 'parent', 'reward_rules.updated', 'reward_rules', p_family::text,
            jsonb_build_object(
              'before', case when previous.family_id is null then null else jsonb_build_object(
                'attemptPoints', previous.attempt_points,
                'independentCorrectBonus', previous.independent_correct_bonus,
                'setCompletionPoints', previous.set_completion_points,
                'minMeaningfulResponseMs', previous.min_meaningful_response_ms) end,
              'after', jsonb_build_object(
                'attemptPoints', saved.attempt_points,
                'independentCorrectBonus', saved.independent_correct_bonus,
                'setCompletionPoints', saved.set_completion_points,
                'minMeaningfulResponseMs', saved.min_meaningful_response_ms)));
  return true;
end
$$;

revoke execute on function public.parent_set_reward_rules(uuid, integer, integer, integer, integer)
  from public, anon, pl_child;
grant execute on function public.parent_set_reward_rules(uuid, integer, integer, integer, integer)
  to authenticated, service_role;

-- Paired children: their own family's point values (the "How you earn points" card).
grant select (family_id, attempt_points, independent_correct_bonus, set_completion_points)
  on public.reward_rules to pl_child;

create policy reward_rules_child_read on public.reward_rules
  for select to pl_child using (family_id = app.current_child_family_id());

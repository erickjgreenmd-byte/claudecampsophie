-- 0400_rewards.sql
-- Spec P9: parent-defined rewards, per-family earning rules, an append-only points ledger whose
-- balance can never go negative (even under concurrent redemptions), and the redemption workflow
-- pending -> approved -> fulfilled | declined | cancelled. Depends on 0001.
-- Points are a family motivational ledger, not money: nothing here transfers value.

create table public.reward_rules (
  family_id uuid primary key references public.families (id),
  attempt_points smallint not null default 2 check (attempt_points between 0 and 100),
  independent_correct_bonus smallint not null default 3 check (independent_correct_bonus between 0 and 100),
  set_completion_points smallint not null default 5 check (set_completion_points between 0 and 100),
  min_meaningful_response_ms integer not null default 1500 check (min_meaningful_response_ms between 0 and 60000),
  updated_at timestamptz not null default now()
);

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  -- Null = available to every child in the family.
  child_id uuid,
  title text not null check (char_length(title) between 1 and 80),
  point_cost integer not null check (point_cost between 1 and 1000000),
  instructions text check (char_length(instructions) <= 500),
  image_path text check (char_length(image_path) <= 300),
  active boolean not null default true,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create index rewards_family on public.rewards (family_id) where active;
create trigger rewards_touch before update on public.rewards
  for each row execute function app.touch_updated_at();

-- One row per child, updated only by the ledger trigger. The CHECK makes a concurrent double-spend
-- abort: the second writer blocks on the row lock, then fails the constraint.
create table public.point_balances (
  child_id uuid primary key,
  family_id uuid not null references public.families (id),
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  reward_id uuid not null references public.rewards (id),
  point_cost integer not null check (point_cost > 0),
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'fulfilled', 'declined', 'cancelled')),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_by text check (cancelled_by in ('child', 'parent')),
  updated_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id)
);

create index reward_redemptions_child on public.reward_redemptions (child_id, requested_at desc);

create table public.points_ledger (
  id bigint generated always as identity primary key,
  family_id uuid not null references public.families (id),
  child_id uuid not null,
  kind text not null check (kind in ('award', 'adjustment', 'redemption_reserve', 'redemption_release')),
  points integer not null check (points <> 0),
  idempotency_key text not null check (char_length(idempotency_key) between 3 and 200),
  reason text check (char_length(reason) <= 300),
  redemption_id uuid references public.reward_redemptions (id),
  actor_kind text not null check (actor_kind in ('system', 'parent', 'child')),
  actor_user_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (child_id, family_id) references public.child_profiles (id, family_id),
  unique (child_id, idempotency_key),
  check (kind <> 'adjustment' or (reason is not null and char_length(btrim(reason)) > 0)),
  check (kind not in ('redemption_reserve', 'redemption_release') or redemption_id is not null),
  check (kind <> 'redemption_reserve' or points < 0),
  check (kind <> 'redemption_release' or points > 0)
);

create index points_ledger_child on public.points_ledger (child_id, id);

create trigger points_ledger_append_only before update or delete on public.points_ledger
  for each row execute function app.prevent_mutation();

create or replace function app.apply_points_to_balance() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.point_balances (child_id, family_id, balance)
    values (new.child_id, new.family_id, 0)
    on conflict (child_id) do nothing;
  update public.point_balances
     set balance = balance + new.points, updated_at = now()
   where child_id = new.child_id;
  return new;
exception
  when check_violation then
    raise exception 'insufficient points for child %', new.child_id using errcode = 'P0001';
end
$$;

create trigger points_ledger_apply after insert on public.points_ledger
  for each row execute function app.apply_points_to_balance();

-- Redemption transitions mirror @pencillift/domain/rewards.
create or replace function app.guard_reward_redemption() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reward redemptions are never deleted' using errcode = 'P0001';
  end if;
  if new.state is distinct from old.state and not (
       (old.state = 'pending' and new.state in ('approved', 'declined', 'cancelled'))
    or (old.state = 'approved' and new.state in ('fulfilled', 'cancelled'))
  ) then
    raise exception 'invalid reward redemption transition % -> %', old.state, new.state using errcode = 'P0001';
  end if;
  if new.point_cost <> old.point_cost or new.child_id <> old.child_id or new.reward_id <> old.reward_id then
    raise exception 'reward redemption facts are immutable' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger reward_redemptions_guard before update or delete on public.reward_redemptions
  for each row execute function app.guard_reward_redemption();

-- ---------------------------------------------------------------------------------------------
-- RPCs. Child identity comes from the DB-verified child session; parent actions need a recent
-- step-up. All return a consistent row so the API can map results.
-- ---------------------------------------------------------------------------------------------

create or replace function public.child_request_reward(p_reward uuid, p_request uuid)
returns public.reward_redemptions
language plpgsql security definer
set search_path = ''
as $$
declare
  me uuid := app.current_child_id();
  fam uuid := app.current_child_family_id();
  r public.rewards;
  existing public.reward_redemptions;
  created public.reward_redemptions;
begin
  if me is null then
    raise exception 'child session required' using errcode = '42501';
  end if;
  -- Idempotent retry of the same request id.
  select * into existing from public.reward_redemptions where id = p_request;
  if found then
    if existing.child_id <> me then
      raise exception 'request id already used' using errcode = 'P0001';
    end if;
    return existing;
  end if;
  select * into r from public.rewards
   where id = p_reward and family_id = fam and active and (child_id is null or child_id = me);
  if not found then
    raise exception 'reward not available' using errcode = 'P0002';
  end if;
  insert into public.reward_redemptions (id, family_id, child_id, reward_id, point_cost)
    values (p_request, fam, me, r.id, r.point_cost)
    returning * into created;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind)
    values (fam, me, 'redemption_reserve', -r.point_cost, 'redeem:' || p_request || ':reserve', p_request, 'child');
  return created;
end
$$;

create or replace function public.child_cancel_reward_request(p_request uuid)
returns public.reward_redemptions
language plpgsql security definer
set search_path = ''
as $$
declare
  me uuid := app.current_child_id();
  req public.reward_redemptions;
begin
  if me is null then
    raise exception 'child session required' using errcode = '42501';
  end if;
  select * into req from public.reward_redemptions where id = p_request and child_id = me for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if req.state = 'cancelled' then
    return req;
  end if;
  if req.state <> 'pending' then
    raise exception 'only pending requests can be cancelled by a child' using errcode = 'P0001';
  end if;
  update public.reward_redemptions set state = 'cancelled', cancelled_by = 'child'
   where id = p_request returning * into req;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind)
    values (req.family_id, me, 'redemption_release', req.point_cost, 'redeem:' || p_request || ':release', p_request, 'child')
    on conflict (child_id, idempotency_key) do nothing;
  return req;
end
$$;

create or replace function public.parent_decide_reward(p_request uuid, p_action text)
returns public.reward_redemptions
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := app.current_user_id();
  req public.reward_redemptions;
  target text;
begin
  select * into req from public.reward_redemptions where id = p_request for update;
  if not found or not app.is_family_member(req.family_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  target := case p_action
    when 'approve' then 'approved'
    when 'decline' then 'declined'
    when 'fulfill' then 'fulfilled'
    when 'cancel' then 'cancelled'
    else null end;
  if target is null then
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;
  -- Repeating an applied action is a no-op (duplicate callbacks do nothing).
  if req.state = target then
    return req;
  end if;
  update public.reward_redemptions
     set state = target,
         decided_by = coalesce(decided_by, uid),
         decided_at = coalesce(decided_at, now()),
         fulfilled_at = case when target = 'fulfilled' then now() else fulfilled_at end,
         cancelled_by = case when target = 'cancelled' then 'parent' else cancelled_by end
   where id = p_request
   returning * into req;
  if target in ('declined', 'cancelled') then
    insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, redemption_id, actor_kind, actor_user_id)
      values (req.family_id, req.child_id, 'redemption_release', req.point_cost,
              'redeem:' || p_request || ':release', p_request, 'parent', uid)
      on conflict (child_id, idempotency_key) do nothing;
  end if;
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, target_type, target_id)
    values (req.family_id, uid, 'parent', 'reward.' || p_action, 'reward_redemption', p_request::text);
  return req;
end
$$;

create or replace function public.parent_adjust_points(
  p_child uuid, p_points integer, p_reason text, p_adjustment uuid)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := app.current_user_id();
  fam uuid;
  entry_id bigint;
begin
  select family_id into fam from public.child_profiles where id = p_child;
  if fam is null or not app.is_family_member(fam) then
    raise exception 'child not found' using errcode = 'P0002';
  end if;
  if not app.has_recent_adult_unlock() then
    raise exception 'recent adult unlock required' using errcode = '42501';
  end if;
  if p_points = 0 then
    raise exception 'adjustment must be non-zero' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  insert into public.points_ledger (family_id, child_id, kind, points, idempotency_key, reason, actor_kind, actor_user_id)
    values (fam, p_child, 'adjustment', p_points, 'adjust:' || p_adjustment, p_reason, 'parent', uid)
    on conflict (child_id, idempotency_key) do nothing
    returning id into entry_id;
  return entry_id;
end
$$;

revoke execute on function public.child_request_reward(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.child_cancel_reward_request(uuid) from public, anon, authenticated;
grant execute on function public.child_request_reward(uuid, uuid) to pl_child, service_role;
grant execute on function public.child_cancel_reward_request(uuid) to pl_child, service_role;
revoke execute on function public.parent_decide_reward(uuid, text) from public, anon, pl_child;
revoke execute on function public.parent_adjust_points(uuid, integer, text, uuid) from public, anon, pl_child;
grant execute on function public.parent_decide_reward(uuid, text) to authenticated, service_role;
grant execute on function public.parent_adjust_points(uuid, integer, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.reward_rules enable row level security;
alter table public.rewards enable row level security;
alter table public.point_balances enable row level security;
alter table public.reward_redemptions enable row level security;
alter table public.points_ledger enable row level security;

revoke all on public.reward_rules, public.rewards, public.point_balances,
  public.reward_redemptions, public.points_ledger from anon;
revoke insert, update, delete on public.point_balances, public.reward_redemptions,
  public.points_ledger, public.reward_rules from authenticated;

-- Parents manage reward definitions directly (with step-up); balances/ledger only via RPCs.
revoke insert, update, delete on public.rewards from authenticated;
grant insert (family_id, child_id, title, point_cost, instructions, image_path, created_by) on public.rewards to authenticated;
grant update (title, point_cost, instructions, image_path, active) on public.rewards to authenticated;

create policy reward_rules_member_read on public.reward_rules
  for select to authenticated using (app.is_family_member(family_id));

create policy rewards_member_read on public.rewards
  for select to authenticated using (app.is_family_member(family_id));
create policy rewards_member_insert on public.rewards
  for insert to authenticated
  with check (app.is_family_member(family_id) and app.has_recent_adult_unlock() and created_by = app.current_user_id());
create policy rewards_member_update on public.rewards
  for update to authenticated
  using (app.is_family_member(family_id) and app.has_recent_adult_unlock())
  with check (app.is_family_member(family_id));

create policy point_balances_member_read on public.point_balances
  for select to authenticated using (app.is_family_member(family_id));
create policy reward_redemptions_member_read on public.reward_redemptions
  for select to authenticated using (app.is_family_member(family_id));
create policy points_ledger_member_read on public.points_ledger
  for select to authenticated using (app.is_family_member(family_id));

-- Children: read their own balance, history, requests and the rewards offered to them.
grant select (id, family_id, child_id, title, point_cost, instructions, image_path, active) on public.rewards to pl_child;
grant select on public.point_balances to pl_child;
grant select (id, child_id, reward_id, point_cost, state, requested_at, decided_at, fulfilled_at)
  on public.reward_redemptions to pl_child;
grant select (id, child_id, kind, points, created_at) on public.points_ledger to pl_child;

create policy rewards_child_read on public.rewards
  for select to pl_child
  using (active and family_id = app.current_child_family_id()
         and (child_id is null or child_id = app.current_child_id()));
create policy point_balances_child_read on public.point_balances
  for select to pl_child using (child_id = app.current_child_id());
create policy reward_redemptions_child_read on public.reward_redemptions
  for select to pl_child using (child_id = app.current_child_id());
create policy points_ledger_child_read on public.points_ledger
  for select to pl_child using (child_id = app.current_child_id());

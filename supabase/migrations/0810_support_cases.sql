-- 0810_support_cases.sql
-- Support cases between a family and the owner's staff (complaints, refund requests, billing
-- issues, bugs, safety questions), their message threads (staff notes are internal and never
-- reach the family) and owner-operations settings (store fee rates for the revenue view).
-- Depends on 0001 (families, admin_users, audit_events) and 0200 (billing_periods).
--
-- Privacy (spec P3/P4): a case is the family's own account conversation. The intake copy tells
-- parents not to include a child's name, homework text or answers, the server caps lengths, and
-- nothing here links to a child, a question or a feedback row. Refunds are issued by the stores,
-- never by PencilLift: a refund_request names one of the family's own provider billing periods so
-- staff can see what the provider later reports (billing_periods.refunded_cents, pending_refunds).
--
-- Access: family members read their family's cases and the non-internal messages, open a case
-- (as a parent, status open) and reply on a case that is not closed. Nothing else is granted to
-- `authenticated`: assignment, status, priority, resolution and internal notes are written by the
-- API as the service role after requireOwnerAdmin (an MFA owner-admin session), with an audit row
-- for each action. Children (pl_child) and anonymous callers have no access at all.

-- ---------------------------------------------------------------------------------------------
-- 1. Cases
-- ---------------------------------------------------------------------------------------------

create table public.support_cases (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id),
  -- A deleted account leaves the case without its author (pseudonymous id only).
  opened_by_user_id uuid references auth.users (id) on delete set null,
  opened_by_kind text not null check (opened_by_kind in ('parent', 'admin')),
  kind text not null check (kind in (
    'complaint', 'refund_request', 'billing_issue', 'bug', 'safety_question', 'other')),
  status text not null default 'open' check (status in (
    'open', 'in_progress', 'waiting_on_parent', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  subject text not null check (char_length(btrim(subject)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  -- The provider billing period a refund request is about: billing_periods' natural key, so a
  -- case only ever names a period the provider actually reported (the channel vocabulary lives
  -- on billing_periods; if a period row were ever removed the link is cleared, not the case).
  channel text,
  provider_period_id text check (char_length(provider_period_id) between 1 and 200),
  assignee_user_id uuid references auth.users (id) on delete set null,
  resolution text check (resolution in (
    'answered', 'fixed', 'refunded_by_store', 'stripe_refund_issued', 'no_refund', 'duplicate')),
  -- The store's or Stripe's refund reference the staff member recorded (never a card or account
  -- number); required when a Stripe refund was issued from the Stripe dashboard.
  resolution_reference text check (char_length(btrim(resolution_reference)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stamped when the case leaves the queue (resolved or closed); cleared when it is reopened.
  resolved_at timestamptz,
  constraint support_cases_period_fkey foreign key (channel, provider_period_id)
    references public.billing_periods (channel, provider_period_id) on delete set null,
  constraint support_cases_period_shape check ((channel is null) = (provider_period_id is null)),
  constraint support_cases_period_kind check (provider_period_id is null or kind = 'refund_request'),
  constraint support_cases_resolved_stamp check ((status in ('resolved', 'closed')) = (resolved_at is not null)),
  constraint support_cases_resolution_status check (resolution is null or status in ('resolved', 'closed')),
  constraint support_cases_resolved_needs_resolution check (status <> 'resolved' or resolution is not null),
  constraint support_cases_stripe_reference check (
    resolution is distinct from 'stripe_refund_issued' or resolution_reference is not null),
  -- A parent-opened case always names the parent; only the service role opens cases as 'admin'.
  constraint support_cases_parent_author check (opened_by_kind <> 'parent' or opened_by_user_id is not null)
);

create index support_cases_family on public.support_cases (family_id, created_at desc);
-- Queue order and keyset paging (status filter, oldest first).
create index support_cases_queue on public.support_cases (status, created_at, id);
create index support_cases_period on public.support_cases (channel, provider_period_id)
  where provider_period_id is not null;

create trigger support_cases_touch before update on public.support_cases
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- 2. Thread messages. `internal` notes are staff-only: the family policy below excludes them and
--    the parent insert grant does not include the column (it defaults to false).
-- ---------------------------------------------------------------------------------------------

create table public.support_case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.support_cases (id) on delete cascade,
  author_kind text not null check (author_kind in ('parent', 'admin')),
  author_user_id uuid references auth.users (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  internal boolean not null default false,
  created_at timestamptz not null default now(),
  -- Only staff write internal notes; a parent message always names the parent.
  constraint support_case_messages_internal_admin check (not internal or author_kind = 'admin'),
  constraint support_case_messages_parent_author check (author_kind <> 'parent' or author_user_id is not null)
);

create index support_case_messages_case on public.support_case_messages (case_id, created_at, id);

-- ---------------------------------------------------------------------------------------------
-- 3. Owner-operations settings (service role only; the API reads and writes them for the owner).
-- ---------------------------------------------------------------------------------------------

create table public.ops_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create trigger ops_settings_touch before update on public.ops_settings
  for each row execute function app.touch_updated_at();

-- Store fee rates used by the owner's revenue view (an estimate: the store statements are the
-- truth). Fractions of the charged amount. Stripe's per-transaction fee is not modelled (0).
insert into public.ops_settings (key, value)
values ('store_fee_rates',
        '{"app_store": 0.30, "play_store": 0.30, "amazon_appstore": 0.30, "stripe": 0}'::text::jsonb);

-- ---------------------------------------------------------------------------------------------
-- 4. RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.support_cases enable row level security;
alter table public.support_case_messages enable row level security;
alter table public.ops_settings enable row level security;

revoke all on public.support_cases, public.support_case_messages, public.ops_settings
  from anon, pl_child;
revoke all on public.ops_settings from authenticated;
revoke insert, update, delete on public.support_cases, public.support_case_messages
  from authenticated;

-- A parent opens a case with exactly these columns: status, priority, assignee and resolution
-- keep their defaults (open, normal, none), and the author must be the caller (policy below).
grant insert (family_id, opened_by_user_id, opened_by_kind, kind, subject, body, channel, provider_period_id)
  on public.support_cases to authenticated;
-- A parent reply is never internal (the column is not granted; the policy checks it too).
grant insert (case_id, author_kind, author_user_id, body)
  on public.support_case_messages to authenticated;

create policy support_cases_member_read on public.support_cases
  for select to authenticated using (app.is_family_member(family_id));

create policy support_cases_member_insert on public.support_cases
  for insert to authenticated
  with check (
    app.is_family_member(family_id)
    and opened_by_kind = 'parent'
    and opened_by_user_id = app.current_user_id()
    and status = 'open'
    and priority = 'normal'
    and assignee_user_id is null
    and resolution is null
    -- A refund request may only name one of this family's own provider billing periods.
    and (
      provider_period_id is null
      or exists (
        select 1 from public.billing_periods p
         where p.family_id = support_cases.family_id
           and p.channel = support_cases.channel
           and p.provider_period_id = support_cases.provider_period_id)
    )
  );

-- Families read the thread of their own cases without the staff's internal notes.
create policy support_case_messages_member_read on public.support_case_messages
  for select to authenticated
  using (
    not internal
    and exists (
      select 1 from public.support_cases c
       where c.id = support_case_messages.case_id and app.is_family_member(c.family_id))
  );

-- A parent replies on a case of their family that is not closed.
create policy support_case_messages_member_insert on public.support_case_messages
  for insert to authenticated
  with check (
    author_kind = 'parent'
    and author_user_id = app.current_user_id()
    and not internal
    and exists (
      select 1 from public.support_cases c
       where c.id = support_case_messages.case_id
         and app.is_family_member(c.family_id)
         and c.status <> 'closed')
  );

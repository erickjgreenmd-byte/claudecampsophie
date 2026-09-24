-- 0640_monetization.sql
-- P16: parent-only monetization. First-party sponsor cards (sponsors, immutable creative versions,
-- campaigns with a reviewed workflow), placement rules, provider/platform policy approvals, owner
-- kill switches, the reviewed resource catalog, family commercial preferences, ad-free store
-- feature mappings, short-lived private serve state, aggregate-only counters and reports, and an
-- append-only revenue ledger. Depends on 0001 (identity, audit, helpers) and 0200 (billing tables
-- read by the API for ad-free entitlements). See spec P16 and docs/Architecture.md.
--
-- Access model: every table below is admin/API-only. The API reads and writes them with the
-- service role after assertOwnerAdmin (owner routes) or after verifying the parent session, unlock
-- and family membership (parent routes). anon, authenticated and pl_child hold NO privilege on any
-- of them except family_monetization_prefs, which a family member may read (never write) under RLS.
-- No table stores child data, and the counters/reports never store a family, user or child id.

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- True when every element matches the pattern (and the array is non-empty). Used in checks.
create or replace function app.all_match(p_values text[], p_pattern text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(cardinality(p_values) > 0 and bool_and(v ~ p_pattern), false)
    from unnest(p_values) as v
$$;

create or replace function app.monetization_no_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'rows in %.% are never deleted (audit trail)', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

-- A policy evidence / linking-tool reference must point at a document, ticket or letter. Never a
-- status word, flag or boolean in any punctuation ('Approved.', 'amazon_associates=true'), a
-- serialized value ('{"approved":true}'), a credential (Amazon 'amzn1.' client ids, JWTs, opaque
-- keys) or a bare Associates tracking id / the approval's own publisher tag (RV-MON-08). Labeled
-- 'fixture:' references pass here; the API refuses them outside development/test. Mirrors
-- @pencillift/domain/monetization evidenceQuality(); the word list equals NON_IDENTIFYING_WORDS
-- (apps/api/tests/admin-monetization.test.ts checks that the two lists stay identical).
create or replace function app.monetization_reference_ok(p_ref text, p_tag text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_ref is null then false
    when lower(btrim(p_ref)) like 'fixture:%' then char_length(btrim(p_ref)) >= 11
    else char_length(btrim(p_ref)) between 6 and 300
      and btrim(p_ref) !~ '^[\[{]'
      and btrim(p_ref) !~* '^(amzn1\.|eyJ[A-Za-z0-9_-]{8,}\.|bearer\s)'
      and btrim(p_ref) !~ '^[A-Za-z0-9+/=]{32,}$'
      and btrim(p_ref) !~* '^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*-2[0-9]$'
      and not (
        array_remove(regexp_split_to_array(
          case when p_tag is null or btrim(p_tag) = '' then lower(btrim(p_ref))
               else replace(lower(btrim(p_ref)), lower(btrim(p_tag)), ' ') end,
          '[^a-z0-9]+'), '')
        <@ array[
      'true', 'false', 'yes', 'no', 'on', 'off', 'ok', 'okay', 'enabled', 'disabled', 'approved',
      'granted', 'eligible', 'pending', 'unknown', 'none', 'null', 'undefined', 'na', 'tbd', 'todo',
      'test', 'testing', 'fixture', 'mock', 'placeholder', 'evidence', 'y', 'n', 'a', '0', '1', 'nil',
      'enable', 'disable', 'approve', 'approval', 'grant', 'eligibility', 'verified', 'confirmed',
      'accepted', 'allowed', 'active', 'live', 'done', 'complete', 'completed', 'pass', 'passed',
      'valid', 'checked', 'reviewed', 'review', 'status', 'flag', 'set', 'value', 'is', 'was', 'has',
      'been', 'by', 'the', 'and', 'for', 'of', 'to', 'in', 'it', 'we', 'are', 'our', 'all', 'see',
      'amazon', 'associate', 'associates', 'affiliate', 'program', 'programme', 'account', 'sponsor',
      'direct', 'network', 'ad', 'ads', 'provider', 'ios', 'android', 'web', 'app', 'apps', 'mobile',
      'site', 'website', 'store', 'tag', 'tracking', 'id', 'publisher', 'key', 'api', 'client',
      'secret', 'token', 'policy'
        ]::text[])
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Sponsors and immutable creative versions
-- ---------------------------------------------------------------------------------------------

create table public.sponsors (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(business_name) between 2 and 120
    and business_name !~ '[<>]'),
  -- Reference to the owner's contract/CRM record; never personal contact details.
  contact_ref text check (char_length(contact_ref) <= 200),
  -- Reviewed destination domains for this sponsor's calls to action (subdomains included).
  allowed_domains text[] not null check (cardinality(allowed_domains) between 1 and 20
    and app.all_match(allowed_domains, '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sponsors_touch before update on public.sponsors
  for each row execute function app.touch_updated_at();
create trigger sponsors_no_delete before delete on public.sponsors
  for each row execute function app.monetization_no_delete();

create table public.sponsor_creatives (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors (id),
  version integer not null check (version >= 1),
  -- The reviewed "Sponsored by <business>" name. Copied from the sponsor when the version is
  -- created (app.guard_sponsor_creative) and immutable like the rest of the version, so renaming a
  -- sponsor reaches parents only through a new, human-reviewed creative version (RV-MON-05).
  sponsor_name text not null check (char_length(sponsor_name) between 2 and 120 and sponsor_name !~ '[<>]'),
  -- Plain text only: no markup, script schemes or event handlers (defense in depth; the API runs
  -- the full @pencillift/domain/monetization validateCreative first).
  headline text not null check (char_length(btrim(headline)) between 1 and 80 and char_length(headline) <= 80),
  body text not null check (char_length(btrim(body)) between 1 and 240 and char_length(body) <= 240),
  cta_label text not null check (char_length(btrim(cta_label)) between 1 and 24 and char_length(cta_label) <= 24),
  destination_url text not null check (char_length(destination_url) <= 500
    and destination_url ~ '^https://[a-z0-9.-]+(/[^\s<>"''`]*)?$'),
  -- First-party asset key in our own storage; never a URL (no third-party asset fetches).
  image_asset_ref text check (image_asset_ref ~ '^[a-z0-9][a-z0-9/_.-]{2,200}$' and image_asset_ref !~ '\.\.'),
  image_license_ref text check (char_length(btrim(image_license_ref)) between 6 and 200),
  review_status text not null default 'draft'
    check (review_status in ('draft', 'in_review', 'approved', 'rejected')),
  created_by uuid not null references auth.users (id),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  -- True when the only owner admin reviewed their own creative (recorded, not hidden).
  self_reviewed boolean not null default false,
  review_note text check (char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  unique (sponsor_id, version),
  unique (id, sponsor_id),
  check (image_asset_ref is null or image_license_ref is not null),
  check ((review_status in ('approved', 'rejected')) = (reviewed_by is not null and reviewed_at is not null)),
  check (headline !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]'),
  check (body !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]'),
  check (cta_label !~* '(javascript|vbscript|data)\s*:|\mon[a-z]+\s*=|[<>]')
);

-- Versions are immutable: editing creates a new version; only the review workflow may change a
-- draft/in-review row, and approved/rejected rows never change again.
create or replace function app.guard_sponsor_creative() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.review_status <> 'draft' then
      raise exception 'a new creative version starts as a draft' using errcode = 'P0001';
    end if;
    -- The label is always the sponsor's name at creation time, never a caller-supplied value.
    new.sponsor_name := (select s.business_name from public.sponsors s where s.id = new.sponsor_id);
    return new;
  end if;
  if old.review_status in ('approved', 'rejected') then
    raise exception 'creative version % is %; create a new version instead', old.version, old.review_status
      using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'review_note', 'self_reviewed'])
     <> (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'review_note', 'self_reviewed']) then
    raise exception 'creative content is immutable; create a new version' using errcode = 'P0001';
  end if;
  if new.review_status is distinct from old.review_status and not (
       (old.review_status = 'draft' and new.review_status = 'in_review')
    or (old.review_status = 'in_review' and new.review_status in ('approved', 'rejected', 'draft'))
  ) then
    raise exception 'invalid creative review transition % -> %', old.review_status, new.review_status
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger sponsor_creatives_guard before insert or update on public.sponsor_creatives
  for each row execute function app.guard_sponsor_creative();
create trigger sponsor_creatives_no_delete before delete on public.sponsor_creatives
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Campaigns (spec P16.5 workflow; mirrors @pencillift/domain/monetization campaignTransition)
-- ---------------------------------------------------------------------------------------------

create table public.sponsor_campaigns (
  id uuid primary key default gen_random_uuid(),
  sponsor_id uuid not null references public.sponsors (id),
  creative_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  placement text not null check (placement in ('adult_dashboard', 'resources_browse')),
  platforms text[] not null check (cardinality(platforms) > 0 and platforms <@ array['ios', 'android', 'web']),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Viewable-impression cap; never unlimited.
  impression_cap integer not null check (impression_cap > 0),
  fee_model text not null check (fee_model in ('fixed_fee', 'none')),
  contracted_fee_cents integer not null default 0 check (contracted_fee_cents >= 0),
  invoice_status text not null default 'not_invoiced'
    check (invoice_status in ('not_invoiced', 'invoiced', 'paid', 'void')),
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'scheduled', 'active', 'paused', 'ended', 'rejected')),
  paused_reason text check (char_length(paused_reason) <= 200),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (creative_id, sponsor_id) references public.sponsor_creatives (id, sponsor_id),
  check (ends_at > starts_at),
  check ((fee_model = 'fixed_fee') = (contracted_fee_cents > 0)),
  check (status <> 'paused' or paused_reason is not null)
);

create index sponsor_campaigns_serving on public.sponsor_campaigns (placement, status);

create or replace function app.guard_sponsor_campaign() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  creative_status text;
  sponsor_status text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'campaigns start as drafts' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.sponsor_id <> old.sponsor_id or new.created_by <> old.created_by then
    raise exception 'campaign sponsor is immutable' using errcode = 'P0001';
  end if;
  -- An ended campaign is frozen except for its invoice/payment bookkeeping.
  if old.status = 'ended' and (to_jsonb(new) - array['invoice_status', 'updated_at'])
       <> (to_jsonb(old) - array['invoice_status', 'updated_at']) then
    raise exception 'campaign has ended' using errcode = 'P0001';
  end if;
  -- A changed creative (or audience surface) needs human review again (spec P16.5).
  if (new.creative_id <> old.creative_id or new.placement <> old.placement or new.platforms <> old.platforms)
     and old.status in ('scheduled', 'active', 'paused') then
    if new.status is distinct from old.status and new.status <> 'in_review' then
      raise exception 'a changed campaign must return to review' using errcode = 'P0001';
    end if;
    new.status := 'in_review';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'in_review')
    or (old.status = 'in_review' and new.status in ('scheduled', 'rejected'))
    or (old.status = 'scheduled' and new.status in ('active', 'paused', 'ended', 'in_review'))
    or (old.status = 'active' and new.status in ('paused', 'ended', 'in_review'))
    or (old.status = 'paused' and new.status in ('active', 'ended', 'in_review'))
    or (old.status = 'rejected' and new.status = 'draft')
  ) then
    raise exception 'invalid campaign transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if new.status in ('scheduled', 'active') then
    select review_status into creative_status from public.sponsor_creatives where id = new.creative_id;
    if creative_status is distinct from 'approved' then
      raise exception 'only an approved creative version can be scheduled or active' using errcode = 'P0001';
    end if;
    select status into sponsor_status from public.sponsors where id = new.sponsor_id;
    if sponsor_status is distinct from 'active' then
      raise exception 'sponsor is suspended' using errcode = 'P0001';
    end if;
  end if;
  if new.status <> 'paused' then
    new.paused_reason := null;
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger sponsor_campaigns_guard before insert or update on public.sponsor_campaigns
  for each row execute function app.guard_sponsor_campaign();
create trigger sponsor_campaigns_no_delete before delete on public.sponsor_campaigns
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Placement rules (spec P16.1: one card per screen, <= 3 new cards per session by default)
-- ---------------------------------------------------------------------------------------------

create table public.placement_rules (
  placement text primary key check (placement in ('adult_dashboard', 'resources_browse')),
  max_cards_per_screen smallint not null default 1 check (max_cards_per_screen = 1),
  -- The owner may lower the per-session cap but never raise it above the spec default of three.
  max_new_cards_per_session smallint not null default 3 check (max_new_cards_per_session between 0 and 3),
  -- Documented visible-duration rule for a billable (viewable) impression.
  min_visible_ms integer not null default 1000 check (min_visible_ms between 1000 and 60000),
  min_visible_ratio numeric(3, 2) not null default 0.50 check (min_visible_ratio between 0.50 and 1.00),
  enabled boolean not null default true,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

insert into public.placement_rules (placement) values ('adult_dashboard'), ('resources_browse');

create trigger placement_rules_no_delete before delete on public.placement_rules
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Provider/platform policy approvals and kill switches (spec P16.2, AC_MON_09/10/14)
-- ---------------------------------------------------------------------------------------------

create table public.monetization_approvals (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('sponsor_direct', 'amazon_associates', 'ad_network')),
  platform text not null check (platform in ('ios', 'android', 'web')),
  -- Bundle id / package name / web origin of the actual reviewed property.
  property_identifier text not null check (char_length(property_identifier) between 3 and 200),
  locale text not null check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  intended_audience text not null check (char_length(btrim(intended_audience)) between 3 and 200),
  vendor_sdk_version text check (char_length(vendor_sdk_version) between 1 and 60),
  policy_reviewed_at timestamptz not null,
  -- Reference to the actual policy evidence; a boolean/stub/key/tag can never be evidence.
  evidence_ref text not null,
  approval_scope text not null check (char_length(btrim(approval_scope)) between 3 and 500),
  -- Amazon publisher-level tag issued under this approval (null for other providers).
  publisher_tag text check (publisher_tag ~* '^[a-z0-9][a-z0-9-]{1,60}-[0-9]{2}$'),
  -- Amazon only: reference to the recorded determination of which Amazon-permitted linking
  -- tool/API this property may use (spec P16.3, AC_MON_10). Mobile affiliate mode stays off
  -- without it (@pencillift/domain/monetization providerGate, RV-MON-09).
  linking_tool_ref text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'revoked', 'expired')),
  status_reason text check (char_length(status_reason) <= 300),
  expires_at timestamptz not null,
  recorded_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > policy_reviewed_at),
  check (provider = 'amazon_associates' or publisher_tag is null),
  check (provider = 'amazon_associates' or linking_tool_ref is null),
  constraint monetization_approvals_evidence_ref_check
    check (app.monetization_reference_ok(evidence_ref, publisher_tag)),
  constraint monetization_approvals_linking_tool_ref_check
    check (linking_tool_ref is null or app.monetization_reference_ok(linking_tool_ref, publisher_tag))
);

create index monetization_approvals_lookup on public.monetization_approvals (provider, platform, status);

-- Evidence and scope are immutable; only the status may move (record a new approval to change facts).
create or replace function app.guard_monetization_approval() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'status_reason', 'updated_at'])
     <> (to_jsonb(old) - array['status', 'status_reason', 'updated_at']) then
    raise exception 'approval evidence is immutable; record a new approval' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'rejected', 'revoked'))
    or (old.status = 'approved' and new.status in ('revoked', 'expired'))
  ) then
    raise exception 'invalid approval transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger monetization_approvals_guard before update on public.monetization_approvals
  for each row execute function app.guard_monetization_approval();
create trigger monetization_approvals_no_delete before delete on public.monetization_approvals
  for each row execute function app.monetization_no_delete();

create table public.monetization_switches (
  key text primary key check (key in (
    'global', 'provider:sponsor_direct', 'provider:amazon_associates', 'provider:ad_network')),
  enabled boolean not null default false,
  changed_by uuid references auth.users (id),
  changed_at timestamptz not null default now(),
  reason text check (char_length(reason) <= 300)
);

-- Monetization is OFF until the owner turns it on (and approvals exist).
insert into public.monetization_switches (key, enabled, reason) values
  ('global', false, 'default off'),
  ('provider:sponsor_direct', false, 'default off'),
  ('provider:amazon_associates', false, 'default off'),
  ('provider:ad_network', false, 'default off');

create trigger monetization_switches_no_delete before delete on public.monetization_switches
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Reviewed resource catalog (spec P10, P16.3)
-- ---------------------------------------------------------------------------------------------

create table public.resource_catalog (
  id uuid primary key default gen_random_uuid(),
  stable_key text not null unique check (stable_key ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  title text not null check (char_length(btrim(title)) between 2 and 120 and title !~ '[<>]'),
  -- Our own (or authorized) factual description; never scraped merchant copy.
  description text not null check (char_length(btrim(description)) between 10 and 600 and description !~ '[<>]'),
  skills text[] not null default '{}' check (cardinality(skills) <= 20
    and (cardinality(skills) = 0 or app.all_match(skills, '^[a-z0-9][a-z0-9_.:-]{0,63}$'))),
  subjects text[] not null check (cardinality(subjects) > 0 and subjects <@ array[
    'math', 'reading', 'spelling_vocabulary', 'grammar_writing', 'science', 'social_studies']),
  grade_min smallint not null check (grade_min between 0 and 12),
  grade_max smallint not null check (grade_max between 0 and 12),
  kind text not null check (kind in ('workbook', 'flashcards', 'manipulative', 'parent_exercise', 'in_app_practice')),
  merchant text not null check (merchant in ('amazon', 'other', 'none')),
  -- Canonical, query-free https URL; Amazon URLs are exactly https://www.amazon.com/dp/<ASIN>.
  merchant_url text check (char_length(merchant_url) <= 500 and merchant_url ~ '^https://[a-z0-9.-]+(/[^\s?#<>"''`]*)?$'),
  image_asset_ref text check (image_asset_ref ~ '^[a-z0-9][a-z0-9/_.-]{2,200}$' and image_asset_ref !~ '\.\.'),
  image_license_ref text check (char_length(btrim(image_license_ref)) between 6 and 200),
  availability text not null default 'unknown' check (availability in ('available', 'unavailable', 'unknown')),
  last_link_check_at timestamptz,
  last_link_check_status text check (last_link_check_status in ('ok', 'broken', 'error', 'skipped')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (grade_max >= grade_min),
  check ((merchant = 'none') = (merchant_url is null)),
  check (merchant <> 'amazon' or merchant_url ~ '^https://www\.amazon\.com/dp/[A-Z0-9]{10}$'),
  check (merchant <> 'other' or merchant_url !~* '^https://([a-z0-9-]+\.)*amazon\.'),
  -- Free learning options never carry a merchant link.
  check (kind not in ('parent_exercise', 'in_app_practice') or merchant = 'none'),
  check (image_asset_ref is null or image_license_ref is not null),
  check (status <> 'approved' or (reviewed_by is not null and reviewed_at is not null))
);

create trigger resource_catalog_touch before update on public.resource_catalog
  for each row execute function app.touch_updated_at();
create trigger resource_catalog_no_delete before delete on public.resource_catalog
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Family preferences and conditional ad-free entitlement mapping (AC_MON_04)
-- ---------------------------------------------------------------------------------------------

create table public.family_monetization_prefs (
  family_id uuid primary key references public.families (id),
  hide_affiliate boolean not null default false,
  hide_sponsor_cards boolean not null default false,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);

-- Maps a verified store product to a feature. The ad-free offer is not approved for sale, so no
-- row is seeded and new rows default to inactive; tests prove the behavior with fixture rows.
create table public.store_feature_mappings (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('app_store', 'play_store', 'stripe')),
  product_id text not null check (char_length(product_id) between 1 and 200),
  environment text not null check (environment in ('sandbox', 'production')),
  feature text not null check (feature = 'ad_free'),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, product_id, environment, feature)
);

create trigger store_feature_mappings_touch before update on public.store_feature_mappings
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Short-lived first-party serve state (private; never exposed). Keyed by a peppered hash of the
-- Supabase auth session id, NOT by family/user/child id. Retention: 7 days, purged by the
-- scheduler (apps/api/src/services/monetization-retention.ts purgeExpiredServes).
-- ---------------------------------------------------------------------------------------------

create table private.placement_serves (
  serve_token_hash text primary key check (serve_token_hash ~ '^[0-9a-f]{64}$'),
  session_key_hash text not null check (session_key_hash ~ '^[0-9a-f]{64}$'),
  campaign_id uuid not null references public.sponsor_campaigns (id),
  placement text not null check (placement in ('adult_dashboard', 'resources_browse')),
  platform text not null check (platform in ('ios', 'android', 'web')),
  locale text not null default 'en-US' check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  served_at timestamptz not null,
  viewed_at timestamptz,
  clicked_at timestamptz,
  dismissed_at timestamptz,
  reported_at timestamptz
);

create index placement_serves_session on private.placement_serves (session_key_hash, served_at);
create index placement_serves_retention on private.placement_serves (served_at);

-- ---------------------------------------------------------------------------------------------
-- Aggregate counters and ad reports: no family, user, child or session identifier (AC_MON_16)
-- ---------------------------------------------------------------------------------------------

create table public.aggregate_ad_events (
  id bigint generated always as identity primary key,
  campaign_id uuid references public.sponsor_campaigns (id),
  catalog_id uuid references public.resource_catalog (id),
  event_date date not null,
  platform text not null check (platform in ('ios', 'android', 'web')),
  placement text not null check (placement in ('adult_dashboard', 'resources_browse')),
  kind text not null check (kind in ('opportunity', 'served', 'viewable_impression', 'click', 'dismiss', 'report')),
  count integer not null default 0 check (count >= 0),
  check (num_nonnulls(campaign_id, catalog_id) <= 1),
  constraint aggregate_ad_events_cell unique nulls not distinct
    (campaign_id, catalog_id, event_date, platform, placement, kind)
);

-- Counters only grow; their identity never changes and rows are never deleted.
create or replace function app.guard_aggregate_ad_event() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'aggregate counters are never deleted' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'count') <> (to_jsonb(old) - 'count') or new.count < old.count then
    raise exception 'aggregate counters only increase' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger aggregate_ad_events_guard before update or delete on public.aggregate_ad_events
  for each row execute function app.guard_aggregate_ad_event();

create table public.ad_reports (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.sponsor_campaigns (id),
  catalog_id uuid references public.resource_catalog (id),
  category text not null check (category in ('inappropriate', 'misleading', 'irrelevant', 'other')),
  platform text not null check (platform in ('ios', 'android', 'web')),
  placement text not null check (placement in ('adult_dashboard', 'resources_browse')),
  -- Date only (no timestamp) so a report cannot be joined back to a session.
  created_date date not null,
  status text not null default 'open' check (status in ('open', 'reviewed')),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  check (num_nonnulls(campaign_id, catalog_id) = 1),
  check ((status = 'reviewed') = (reviewed_by is not null and reviewed_at is not null))
);

create trigger ad_reports_no_delete before delete on public.ad_reports
  for each row execute function app.monetization_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Revenue ledger (append-only; AC_MON_17/18). Forecasts stay in the `projected` category and are
-- never summed into recognized or received amounts. Clicks are never revenue rows.
-- ---------------------------------------------------------------------------------------------

create table public.revenue_imports (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('sponsor_invoice', 'amazon_report', 'ad_network', 'manual')),
  -- sha256 of the canonical import payload: the same file can never be imported twice.
  file_sha256 text not null unique check (file_sha256 ~ '^[0-9a-f]{64}$'),
  period_month text not null check (period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  imported_by uuid not null references auth.users (id),
  row_count integer not null check (row_count >= 0),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  unique (id, source)
);

create table public.revenue_entries (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null,
  source text not null,
  external_ref text not null check (char_length(btrim(external_ref)) between 1 and 200),
  category text not null check (category in ('projected', 'contracted', 'recognized', 'received', 'affiliate_reported')),
  provider text not null check (provider in ('sponsor_direct', 'amazon_associates', 'ad_network')),
  campaign_id uuid references public.sponsor_campaigns (id),
  placement text check (placement in ('adult_dashboard', 'resources_browse')),
  amount_cents integer not null check (amount_cents between 0 and 2000000000),
  currency text not null default 'USD' check (currency = 'USD'),
  period_month text not null check (period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default now(),
  foreign key (import_id, source) references public.revenue_imports (id, source),
  unique (source, external_ref, category),
  -- A provider's report row is one fact whatever source label it is imported under: the same
  -- provider reference/category can never be booked twice, e.g. once as 'amazon_report' and again
  -- as 'manual' (RV-MON-06).
  unique (provider, external_ref, category),
  -- Sponsor and network inventory must name its placement so the same sold inventory is never
  -- counted twice (fixed sponsor fees substitute for network revenue).
  check (provider = 'amazon_associates' or placement is not null),
  check (campaign_id is null or provider = 'sponsor_direct')
);

create index revenue_entries_month on public.revenue_entries (period_month);

-- A sponsor row that references a campaign names that campaign's placement: the same-inventory
-- double-count guard keys on placement, so a mismatched row could hide a sponsor fee from it
-- (RV-MON-07). The API validates first; this is the second layer.
create or replace function app.guard_revenue_entry_campaign() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  campaign_placement text;
begin
  if new.campaign_id is not null then
    select placement into campaign_placement from public.sponsor_campaigns where id = new.campaign_id;
    if campaign_placement is not null and new.placement is distinct from campaign_placement then
      raise exception 'revenue row placement % does not match its campaign placement %',
        new.placement, campaign_placement using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

create trigger revenue_entries_campaign_placement before insert on public.revenue_entries
  for each row execute function app.guard_revenue_entry_campaign();

create table public.revenue_adjustments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.revenue_entries (id),
  kind text not null check (kind in ('refund', 'reversal', 'correction')),
  -- Signed delta; refunds and reversals reduce the entry.
  amount_cents integer not null check (amount_cents <> 0 and amount_cents between -2000000000 and 2000000000),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  check (kind = 'correction' or amount_cents < 0)
);

-- An entry's net amount (entry + adjustments) can never go below zero.
create or replace function app.guard_revenue_adjustment() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  base bigint;
  adjusted bigint;
begin
  select amount_cents into base from public.revenue_entries where id = new.entry_id for update;
  select coalesce(sum(amount_cents), 0) into adjusted from public.revenue_adjustments where entry_id = new.entry_id;
  if base + adjusted + new.amount_cents < 0 then
    raise exception 'adjustment would take the entry below zero' using errcode = 'P0001';
  end if;
  return new;
end
$$;

create trigger revenue_adjustments_bounds before insert on public.revenue_adjustments
  for each row execute function app.guard_revenue_adjustment();

create trigger revenue_imports_append_only before update or delete on public.revenue_imports
  for each row execute function app.prevent_mutation();
create trigger revenue_entries_append_only before update or delete on public.revenue_entries
  for each row execute function app.prevent_mutation();
create trigger revenue_adjustments_append_only before update or delete on public.revenue_adjustments
  for each row execute function app.prevent_mutation();

-- ---------------------------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------------------------

alter table public.sponsors enable row level security;
alter table public.sponsor_creatives enable row level security;
alter table public.sponsor_campaigns enable row level security;
alter table public.placement_rules enable row level security;
alter table public.monetization_approvals enable row level security;
alter table public.monetization_switches enable row level security;
alter table public.resource_catalog enable row level security;
alter table public.family_monetization_prefs enable row level security;
alter table public.store_feature_mappings enable row level security;
alter table public.aggregate_ad_events enable row level security;
alter table public.ad_reports enable row level security;
alter table public.revenue_imports enable row level security;
alter table public.revenue_entries enable row level security;
alter table public.revenue_adjustments enable row level security;

-- Admin/API-only tables: no client role holds any privilege (and RLS has no client policy).
revoke all on public.sponsors, public.sponsor_creatives, public.sponsor_campaigns,
  public.placement_rules, public.monetization_approvals, public.monetization_switches,
  public.resource_catalog, public.family_monetization_prefs, public.store_feature_mappings,
  public.aggregate_ad_events, public.ad_reports, public.revenue_imports, public.revenue_entries,
  public.revenue_adjustments
  from anon, authenticated, pl_child;
revoke all on sequence public.aggregate_ad_events_id_seq from anon, authenticated, pl_child;

-- A family member may read (never write) their own family's commercial preferences.
grant select (family_id, hide_affiliate, hide_sponsor_cards, updated_at)
  on public.family_monetization_prefs to authenticated;
create policy family_monetization_prefs_member_read on public.family_monetization_prefs
  for select to authenticated using (app.is_family_member(family_id));

revoke execute on function app.all_match(text[], text) from public, anon;
revoke execute on function app.monetization_reference_ok(text, text) from public, anon;

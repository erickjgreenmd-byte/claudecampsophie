-- 0770_catalog_fixture_guard.sql
-- AC_DEPLOY_07 (spec: "Production must reject mocked billing, consent, AI grading and fake catalog
-- data"). One definition of a fixture or fake catalog row, the per-catalog count the owner
-- readiness report reads (apps/api/src/config.ts loadReadinessFacts), and a production guard: once
-- the owner marks this database as the production database (private.deployment), live fixture or
-- fake rows are refused, and the mark itself is refused while any exist. Development, test and
-- staging databases are never marked production, so labeled fixtures keep working there.
-- Depends on 0001 (schemas, grants), 0200 (store_product_mappings), 0300 (provider_offer_mappings)
-- and 0640 (resource_catalog, monetization_approvals, store_feature_mappings, sponsors,
-- sponsor_creatives, sponsor_campaigns).
--
-- A catalog row is fake when it
-- - carries the labeled-fixture convention: 'fixture:' evidence references (0640, which accepts
--   them only for the API to refuse outside development/test), 'fixture.' / 'fixture_' /
--   'fixture-' / 'fixture:' product, plan and offer ids, 'fixture-' resource keys and 'fixture:'
--   image licence references (resources and sponsor creatives);
-- - points at a host reserved for documentation and testing (RFC 2606, RFC 6761: example.com,
--   example.net, example.org and the .example, .test, .invalid and .localhost names): resource
--   merchant URLs, sponsor creative destinations and sponsor allowed domains; or
-- - (resources) claims availability the catalog's own link check never confirmed. The admin API
--   only ever sets 'available' together with last_link_check_status = 'ok', so any other
--   'available' merchant row was seeded around the reviewed workflow (AI and seeds must not invent
--   availability, spec P10). A check belongs to the URL it checked: changing merchant_url clears
--   availability and the check (resource_catalog_check_reset below), so a new URL is never served
--   on the previous URL's result (LRD-2).
-- It is live when it can be served: resources not retired, approvals pending or approved, store
-- mappings active, provider offers ready, sponsors active, sponsor campaigns from review until they
-- end (in review, scheduled, active or paused; a campaign is fake when its creative or sponsor is).
-- A creative version is served only through a campaign, so it is judged there. Catalog rows are
-- never deleted (audit trail), so retiring, revoking, deactivating, suspending or ending a fake row
-- clears it.

-- ---------------------------------------------------------------------------------------------
-- Definition
-- ---------------------------------------------------------------------------------------------

create or replace function app.is_fixture_label(p_value text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(lower(btrim(p_value)) ~ '^fixture[:._-]', false)
$$;

create or replace function app.is_reserved_test_url(p_url text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(lower(btrim(p_url)) ~ ('^[a-z][a-z0-9+.-]*://([^/?#@]*@)?([a-z0-9-]+\.)*'
    || '(example\.(com|net|org)|example|test|invalid|localhost)\.?(:[0-9]+)?([/?#]|$)'), false)
$$;

create or replace function app.is_reserved_test_domain(p_domain text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(lower(btrim(p_domain))
    ~ '^([a-z0-9-]+\.)*(example\.(com|net|org)|example|test|invalid|localhost)\.?$', false)
$$;

create or replace function app.resource_is_fake(p_row public.resource_catalog) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.status <> 'retired' and (
    p_row.stable_key like 'fixture-%'
    or app.is_fixture_label(p_row.image_license_ref)
    or app.is_reserved_test_url(p_row.merchant_url)
    or (p_row.merchant_url is not null and p_row.availability = 'available'
        and p_row.last_link_check_status is distinct from 'ok')
  )
$$;

create or replace function app.approval_is_fake(p_row public.monetization_approvals) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.status in ('pending', 'approved')
    and (app.is_fixture_label(p_row.evidence_ref) or app.is_fixture_label(p_row.linking_tool_ref))
$$;

create or replace function app.store_product_is_fake(p_row public.store_product_mappings)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.active
    and (app.is_fixture_label(p_row.product_id) or app.is_fixture_label(p_row.base_plan_id))
$$;

create or replace function app.store_feature_is_fake(p_row public.store_feature_mappings)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.active and app.is_fixture_label(p_row.product_id)
$$;

create or replace function app.provider_offer_is_fake(p_row public.provider_offer_mappings)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.status = 'ready' and app.is_fixture_label(p_row.provider_offer_id)
$$;

create or replace function app.sponsor_is_fake(p_row public.sponsors) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_row.status = 'active'
    and exists (select 1 from unnest(p_row.allowed_domains) d where app.is_reserved_test_domain(d))
$$;

create or replace function app.sponsor_creative_is_fake(p_row public.sponsor_creatives)
returns boolean
language sql immutable
set search_path = ''
as $$
  select app.is_reserved_test_url(p_row.destination_url) or app.is_fixture_label(p_row.image_license_ref)
$$;

-- Reads the campaign's creative and sponsor (stable, not immutable).
create or replace function app.sponsor_campaign_is_fake(p_row public.sponsor_campaigns)
returns boolean
language sql stable
set search_path = ''
as $$
  select p_row.status in ('in_review', 'scheduled', 'active', 'paused') and (
    exists (select 1 from public.sponsor_creatives cr
             where cr.id = p_row.creative_id and app.sponsor_creative_is_fake(cr))
    or exists (select 1 from public.sponsors s, unnest(s.allowed_domains) d
                where s.id = p_row.sponsor_id and app.is_reserved_test_domain(d))
  )
$$;

-- Live fixture or fake rows per catalog (counts only: the readiness report never lists rows).
create or replace function app.fake_catalog_rows()
returns table (catalog text, fake_rows integer)
language sql stable
set search_path = ''
as $$
  select 'resource_catalog', count(*)::integer
    from public.resource_catalog r where app.resource_is_fake(r)
  union all
  select 'monetization_approvals', count(*)::integer
    from public.monetization_approvals a where app.approval_is_fake(a)
  union all
  select 'store_product_mappings', count(*)::integer
    from public.store_product_mappings m where app.store_product_is_fake(m)
  union all
  select 'store_feature_mappings', count(*)::integer
    from public.store_feature_mappings m where app.store_feature_is_fake(m)
  union all
  select 'provider_offer_mappings', count(*)::integer
    from public.provider_offer_mappings m where app.provider_offer_is_fake(m)
  union all
  select 'sponsors', count(*)::integer
    from public.sponsors s where app.sponsor_is_fake(s)
  union all
  select 'sponsor_campaigns', count(*)::integer
    from public.sponsor_campaigns c where app.sponsor_campaign_is_fake(c)
$$;

-- ---------------------------------------------------------------------------------------------
-- A link check belongs to the URL it checked
-- ---------------------------------------------------------------------------------------------

-- Any writer that changes merchant_url (the admin PATCH, a seed, an operator) leaves the row
-- unchecked: availability 'unknown' and no check, whatever else the same statement set, so only a
-- check of the new URL can claim availability again. Named to fire before
-- resource_catalog_fixture_guard (same-event triggers fire in name order), which then judges the
-- row that will be stored.
create or replace function app.reset_link_check_on_url_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.merchant_url is distinct from old.merchant_url then
    new.availability := 'unknown';
    new.last_link_check_status := null;
    new.last_link_check_at := null;
  end if;
  return new;
end
$$;

create trigger resource_catalog_check_reset before update on public.resource_catalog
  for each row execute function app.reset_link_check_on_url_change();

-- ---------------------------------------------------------------------------------------------
-- The production mark: one row, written only by the owner (migration role), never by the API
-- ---------------------------------------------------------------------------------------------

create table private.deployment (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment in ('development', 'test', 'staging', 'production')),
  marked_at timestamptz not null default now()
);

-- The API's service role may read the mark (readiness) but never change it.
revoke all on private.deployment from public, anon, authenticated, pl_child, service_role;
grant select on private.deployment to service_role;

-- Null when the database was never marked.
create or replace function app.database_environment() returns text
language sql stable
set search_path = ''
as $$
  select environment from private.deployment where singleton
$$;

create or replace function app.guard_deployment_mark() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.environment = 'production' then
    -- Waits for in-flight catalog writers and holds new ones until this commits, so no fake row can
    -- land between the check and the mark.
    lock table public.resource_catalog, public.monetization_approvals, public.store_product_mappings,
      public.store_feature_mappings, public.provider_offer_mappings, public.sponsors,
      public.sponsor_creatives, public.sponsor_campaigns in share mode;
    if exists (select 1 from app.fake_catalog_rows() f where f.fake_rows > 0) then
      raise exception 'fixture or fake catalog rows are live; retire, revoke or deactivate them before marking this database production'
        using errcode = 'P0001';
    end if;
  end if;
  new.marked_at := now();
  return new;
end
$$;

create trigger deployment_guard before insert or update on private.deployment
  for each row execute function app.guard_deployment_mark();

-- ---------------------------------------------------------------------------------------------
-- The guard: a production database refuses live fixture or fake catalog rows
-- ---------------------------------------------------------------------------------------------

create or replace function app.refuse_fake_catalog_row() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fake boolean;
begin
  if app.database_environment() is distinct from 'production' then
    return new;
  end if;
  -- One branch per table: plpgsql plans only the branch that runs for this table's row type.
  if tg_table_name = 'resource_catalog' then
    v_fake := app.resource_is_fake(new);
  elsif tg_table_name = 'monetization_approvals' then
    v_fake := app.approval_is_fake(new);
  elsif tg_table_name = 'store_product_mappings' then
    v_fake := app.store_product_is_fake(new);
  elsif tg_table_name = 'store_feature_mappings' then
    v_fake := app.store_feature_is_fake(new);
  elsif tg_table_name = 'provider_offer_mappings' then
    v_fake := app.provider_offer_is_fake(new);
  elsif tg_table_name = 'sponsors' then
    v_fake := app.sponsor_is_fake(new);
  elsif tg_table_name = 'sponsor_campaigns' then
    v_fake := app.sponsor_campaign_is_fake(new);
  else
    raise exception 'refuse_fake_catalog_row is not defined for %.%', tg_table_schema, tg_table_name;
  end if;
  if v_fake then
    raise exception 'fixture or fake catalog data is refused in the production database (%.%)',
      tg_table_schema, tg_table_name
      using errcode = 'P0001',
            hint = 'Labeled fixtures, reserved test hosts and unchecked availability belong to development and test databases.';
  end if;
  return new;
end
$$;

create trigger resource_catalog_fixture_guard before insert or update on public.resource_catalog
  for each row execute function app.refuse_fake_catalog_row();
create trigger monetization_approvals_fixture_guard before insert or update on public.monetization_approvals
  for each row execute function app.refuse_fake_catalog_row();
create trigger store_product_mappings_fixture_guard before insert or update on public.store_product_mappings
  for each row execute function app.refuse_fake_catalog_row();
create trigger store_feature_mappings_fixture_guard before insert or update on public.store_feature_mappings
  for each row execute function app.refuse_fake_catalog_row();
create trigger provider_offer_mappings_fixture_guard before insert or update on public.provider_offer_mappings
  for each row execute function app.refuse_fake_catalog_row();
create trigger sponsors_fixture_guard before insert or update on public.sponsors
  for each row execute function app.refuse_fake_catalog_row();
-- Named to fire after sponsor_campaigns_guard (0640; same-event triggers fire in name order), which
-- may move a changed campaign back to review: the check sees the status that will be stored.
create trigger sponsor_campaigns_guard_fixture before insert or update on public.sponsor_campaigns
  for each row execute function app.refuse_fake_catalog_row();

-- Readers of the mark and the counts: the API's service role only.
revoke execute on function app.fake_catalog_rows() from public, anon, authenticated, pl_child;
revoke execute on function app.sponsor_campaign_is_fake(public.sponsor_campaigns)
  from public, anon, authenticated, pl_child;
revoke execute on function app.database_environment() from public, anon, authenticated, pl_child;
grant execute on function app.fake_catalog_rows() to service_role;
grant execute on function app.database_environment() to service_role;

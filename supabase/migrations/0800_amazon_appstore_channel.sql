-- 0800_amazon_appstore_channel.sql
-- Amazon Appstore billing channel. Fire tablets run Android without Google services: purchases go
-- through the Amazon Appstore (RevenueCat store name AMAZON), so 'amazon_appstore' joins
-- 'app_store', 'play_store' and 'stripe' as a billing channel. Every check constraint that
-- enumerates the channels is replaced by one that also allows the new value:
--   0200: store_product_mappings.channel, family_entitlements.channel,
--         family_capacity.managing_channel, billing_periods.channel
--   0300: promo_campaign_templates.channels (array), provider_offer_mappings.channel,
--         promo_redemptions.channel, promo_benefit_periods.channel
--   0640: store_feature_mappings.channel
--   0700: pending_refunds.channel
-- The constraints were auto-named, so their live names are read from pg_constraint: only a check
-- constraint on exactly that column that lists 'play_store' but not 'amazon_appstore' is dropped.
-- Idempotent: a constraint that already allows 'amazon_appstore' is left alone and never added
-- twice. No data changes.

do $$
declare
  spec record;
  old record;
  col_attnum smallint;
  new_name text;
  definition text;
begin
  for spec in
    select *
      from (values
        ('store_product_mappings', 'channel', false),
        ('family_entitlements', 'channel', false),
        ('family_capacity', 'managing_channel', false),
        ('billing_periods', 'channel', false),
        ('promo_campaign_templates', 'channels', true),
        ('provider_offer_mappings', 'channel', false),
        ('promo_redemptions', 'channel', false),
        ('promo_benefit_periods', 'channel', false),
        ('store_feature_mappings', 'channel', false),
        ('pending_refunds', 'channel', false)
      ) as t(table_name, column_name, is_array)
  loop
    col_attnum := null;
    select a.attnum into col_attnum
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = spec.table_name
       and a.attname = spec.column_name
       and not a.attisdropped;
    if col_attnum is null then
      raise exception 'public.%.% does not exist', spec.table_name, spec.column_name;
    end if;

    -- Drop every check constraint on exactly this column that lists the old channels only.
    for old in
      select k.conname
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = spec.table_name
         and k.contype = 'c'
         and k.conkey = array[col_attnum]
         and pg_get_constraintdef(k.oid) like '%''play_store''%'
         and pg_get_constraintdef(k.oid) not like '%''amazon_appstore''%'
    loop
      execute format('alter table public.%I drop constraint %I', spec.table_name, old.conname);
    end loop;

    new_name := spec.table_name || '_' || spec.column_name || '_check';
    if spec.is_array then
      definition := format(
        'check (cardinality(%I) > 0 and %I <@ array[''app_store'', ''play_store'', ''stripe'', ''amazon_appstore''])',
        spec.column_name, spec.column_name);
    else
      definition := format(
        'check (%I in (''app_store'', ''play_store'', ''stripe'', ''amazon_appstore''))',
        spec.column_name);
    end if;
    if not exists (
      select 1
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = spec.table_name and k.conname = new_name
    ) then
      execute format('alter table public.%I add constraint %I %s', spec.table_name, new_name, definition);
    end if;
  end loop;
end
$$;

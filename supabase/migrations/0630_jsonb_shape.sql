-- 0630_jsonb_shape.sql
-- BUG-008: postgres.js encodes a JS string bound to a `::jsonb` parameter as a JSON *string* scalar,
-- so `${JSON.stringify(obj)}::jsonb` silently stored '"{\"a\":1}"' instead of an object (audit
-- metadata, the donation accrual eligibility snapshot). Every structured jsonb column must hold an
-- object or array; a scalar is always this encoding bug, so the database now rejects it. A schema
-- invariant test requires the same check on every jsonb column added later.
--
-- No deployed database exists yet (docs/Progress.md), so no double-encoded rows need repair here.

do $$
declare
  col record;
begin
  for col in
    select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema in ('public', 'private') and c.data_type = 'jsonb'
  loop
    execute format(
      'alter table %I.%I add constraint %I check (%I is null or jsonb_typeof(%I) in (''object'', ''array''))',
      col.table_schema, col.table_name, col.table_name || '_' || col.column_name || '_json_shape',
      col.column_name, col.column_name);
  end loop;
end
$$;

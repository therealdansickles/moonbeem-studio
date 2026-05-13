create or replace function public._inspect_indexes(table_names text[])
returns table(tablename text, indexname text, indexdef text)
language sql
stable
security definer
set search_path = public
as $$
  select tablename::text, indexname::text, indexdef::text
  from pg_indexes
  where schemaname = 'public' and tablename = any(table_names)
  order by tablename, indexname;
$$;

-- find_title_duplicates(limit_n) — admin audit RPC.
--
-- Returns titles that share the same lower(title) with at least one
-- other row (excluding soft-deleted). One result row per group; the
-- count column is total instances. Useful for catalog hygiene work
-- when the JS clients can't efficiently GROUP BY across the 1.4M-row
-- titles table.
--
-- Permissions: service_role only (admin tooling).

create or replace function public.find_title_duplicates(limit_n int default 50)
returns table (
  normalized_title text,
  occurrence_count bigint,
  ids uuid[],
  years int[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    lower(t.title) as normalized_title,
    count(*) as occurrence_count,
    array_agg(t.id order by t.created_at) as ids,
    array_agg(t.year order by t.created_at) as years
  from public.titles t
  where t.deleted_at is null
  group by lower(t.title)
  having count(*) > 1
  order by count(*) desc, lower(t.title) asc
  limit limit_n;
$$;

revoke execute on function public.find_title_duplicates(int) from public;
grant execute on function public.find_title_duplicates(int) to service_role;

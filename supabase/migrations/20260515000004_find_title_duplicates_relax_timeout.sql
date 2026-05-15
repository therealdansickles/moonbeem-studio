-- find_title_duplicates: relax statement timeout for the audit. The
-- 1.4M-row GROUP BY scan finishes in well under 5min but hits the
-- per-role default (1min on the pooler). Function-local SET overrides
-- only for this function's body.

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
set statement_timeout = '5min'
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

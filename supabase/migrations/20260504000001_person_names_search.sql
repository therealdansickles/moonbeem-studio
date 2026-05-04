-- =====================================================================
-- Search by person: GIN-indexed flattened name array
-- =====================================================================
-- Adds a `person_names text[]` column on titles, populated by trigger
-- from the `cast_members` and `crew` JSONB columns. Indexed with GIN
-- so search_titles_by_person() returns in <200ms across 1.4M rows.
--
-- This migration was applied to production via direct asyncpg
-- connection on 2026-05-04 (dashboard SQL editor timed out at the
-- 1.4M-row backfill). The DDL here is idempotent — safe to re-run
-- on fresh databases.
--
-- Production timing reference (Micro compute, maintenance_work_mem=1GB):
--   backfill 1.4M rows: ~31 min
--   GIN build: ~4 min
--   Final index size: 359 MB
-- =====================================================================

-- person_names column: lowercased, deduplicated, flattened cast + crew names
alter table public.titles
  drop column if exists person_names;

alter table public.titles
  add column person_names text[];

-- Trigger function: recomputes person_names whenever cast_members or crew change
create or replace function public.titles_compute_person_names()
returns trigger
language plpgsql
as $$
begin
  new.person_names := array(
    select distinct lower(trim(name_value))
    from (
      select jsonb_array_elements(coalesce(new.cast_members, '[]'::jsonb))->>'name' as name_value
      union all
      select jsonb_array_elements(coalesce(new.crew, '[]'::jsonb))->>'name' as name_value
    ) all_names
    where name_value is not null
      and trim(name_value) != ''
  );
  return new;
end;
$$;

drop trigger if exists titles_person_names_sync on public.titles;
create trigger titles_person_names_sync
  before insert or update of cast_members, crew
  on public.titles
  for each row
  execute function public.titles_compute_person_names();

-- Backfill: forces the trigger to compute person_names for existing rows.
-- On 1.4M rows this takes ~30 minutes on Micro compute. The dashboard SQL
-- editor will timeout — apply via direct asyncpg if running fresh.
update public.titles
  set cast_members = cast_members
  where person_names is null;

-- GIN index for fast contains-name lookup
drop index if exists public.titles_person_names_gin;

create index titles_person_names_gin
  on public.titles
  using gin (person_names);

-- Rewrite search_titles_by_person to use the indexed column.
-- Role priority (Director > Writer > Cinematographer > Editor > Composer > Cast)
-- replaces the previous coalesce(... limit 1) which sorted alphabetically and
-- surfaced wrong roles (e.g., "Set Decoration" for Anna Biller).
create or replace function public.search_titles_by_person(
  person_name text,
  max_results int default 60
)
returns table (
  id uuid,
  slug text,
  title text,
  poster_url text,
  year integer,
  distributor text,
  is_active boolean,
  is_featured boolean,
  role_in_film text
) as $$
declare
  needle text := lower(trim(person_name));
begin
  return query
  select distinct on (t.id)
    t.id, t.slug, t.title, t.poster_url, t.year,
    t.distributor, t.is_active, t.is_featured,
    coalesce(
      (select cm->>'job'
         from jsonb_array_elements(t.crew) cm
         where lower(cm->>'name') = needle
         order by
           case cm->>'job'
             when 'Director' then 1
             when 'Writer' then 2
             when 'Screenplay' then 2
             when 'Director of Photography' then 3
             when 'Cinematography' then 3
             when 'Editor' then 4
             when 'Original Music Composer' then 5
             when 'Composer' then 5
             else 99
           end
         limit 1),
      case when exists (
        select 1 from jsonb_array_elements(t.cast_members) cm
        where lower(cm->>'name') = needle
      ) then 'Cast' else null end
    ) as role_in_film
  from public.titles t
  where t.person_names @> array[needle]
  order by t.id, t.is_featured desc nulls last,
           t.is_active desc, t.popularity desc nulls last
  limit max_results;
end;
$$ language plpgsql stable;

grant execute on function public.search_titles_by_person(text, int)
  to anon, authenticated;

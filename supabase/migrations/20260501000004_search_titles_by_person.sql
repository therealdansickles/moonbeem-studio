-- Search titles where a person appears in either cast_members or crew JSONB.
-- Uses lower() for case-insensitive name match. role_in_film picks the crew
-- job if present, else 'Cast'. distinct on (t.id) collapses people with
-- multiple credits on the same film into one row.

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
begin
  return query
  select distinct on (t.id)
    t.id,
    t.slug,
    t.title,
    t.poster_url,
    t.year,
    t.distributor,
    t.is_active,
    t.is_featured,
    coalesce(
      (select crew_member->>'job'
         from jsonb_array_elements(t.crew) as crew_member
         where lower(crew_member->>'name') = lower(person_name)
         limit 1),
      case when exists (
        select 1 from jsonb_array_elements(t.cast_members) as cast_member
        where lower(cast_member->>'name') = lower(person_name)
      ) then 'Cast' else null end
    ) as role_in_film
  from public.titles t
  where
    (t.cast_members is not null and exists (
      select 1 from jsonb_array_elements(t.cast_members) as cast_member
      where lower(cast_member->>'name') = lower(person_name)
    ))
    or
    (t.crew is not null and exists (
      select 1 from jsonb_array_elements(t.crew) as crew_member
      where lower(crew_member->>'name') = lower(person_name)
    ))
  order by t.id, t.is_featured desc nulls last,
    t.is_active desc, t.popularity desc nulls last
  limit max_results;
end;
$$ language plpgsql stable;

grant execute on function public.search_titles_by_person(text, int)
  to anon, authenticated;

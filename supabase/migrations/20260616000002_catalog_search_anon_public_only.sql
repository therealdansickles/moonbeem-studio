-- Tighten anonymous search to public-only; authenticated users still get the
-- whole catalog. Closes the pre-existing anon catalog-search leak: the search
-- RPCs had no is_public filter, so anonymous callers could find all ~1.43M
-- non-public titles by name/poster (the title PAGE 404s via canViewTitle, but
-- search surfaced names/posters).
--
-- Pure function-body replace (CREATE OR REPLACE, same signatures, SECURITY
-- INVOKER, STABLE). No schema change, no data change, no DROP. The added
-- predicate `(t.is_public OR (SELECT auth.role()) = 'authenticated')` is
-- index-safe: the GIN trigram index (idx_titles_title_trgm) / person_names GIN
-- index (titles_person_names_gin) still leads the scan; auth.role() is
-- evaluated once per call via an InitPlan, and is_public is a cheap residual
-- filter on the already-narrowed candidate set (EXPLAIN-confirmed, ~238 cost,
-- not a 1.43M seq scan).
--
-- NOTE: this is live-on-apply against the single Supabase DB — anon search
-- narrows immediately on apply (signed-in unchanged).

CREATE OR REPLACE FUNCTION public.search_titles(query text, max_results integer DEFAULT 8)
 RETURNS TABLE(id uuid, slug text, title text, poster_url text, year integer, distributor text, is_active boolean, is_featured boolean, rank double precision)
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  return query
  select
    t.id,
    t.slug,
    t.title,
    t.poster_url,
    t.year,
    t.distributor,
    t.is_active,
    t.is_featured,
    (
      case when lower(t.title) = lower(query) then 200.0 else 0.0 end
      + case when t.is_featured then 100.0 else 0.0 end
      + case when t.is_active then 50.0 else 0.0 end
      + case when lower(t.title) like lower(query) || '%' then 30.0 else 0.0 end
      + case when lower(t.title) like '%' || lower(query) || '%' then 10.0 else 0.0 end
      + coalesce(t.popularity, 0)::float / 100.0
    )::float as rank
  from public.titles t
  where lower(t.title) like '%' || lower(query) || '%'
    and t.deleted_at is null
    and (t.is_public or (select auth.role()) = 'authenticated')
  order by rank desc, t.title asc
  limit max_results;
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_titles_by_person(person_name text, max_results integer DEFAULT 60)
 RETURNS TABLE(id uuid, slug text, title text, poster_url text, year integer, distributor text, is_active boolean, is_featured boolean, role_in_film text)
 LANGUAGE plpgsql
 STABLE
AS $function$
        DECLARE
          needle text := lower(trim(person_name));
        BEGIN
          RETURN QUERY
          SELECT DISTINCT ON (t.id)
            t.id, t.slug, t.title, t.poster_url, t.year,
            t.distributor, t.is_active, t.is_featured,
            COALESCE(
              (SELECT cm->>'job'
                 FROM jsonb_array_elements(t.crew) cm
                 WHERE lower(cm->>'name') = needle
                 ORDER BY
                   CASE cm->>'job'
                     WHEN 'Director' THEN 1
                     WHEN 'Writer' THEN 2
                     WHEN 'Screenplay' THEN 2
                     WHEN 'Director of Photography' THEN 3
                     WHEN 'Cinematography' THEN 3
                     WHEN 'Editor' THEN 4
                     WHEN 'Original Music Composer' THEN 5
                     WHEN 'Composer' THEN 5
                     ELSE 99
                   END
                 LIMIT 1),
              CASE WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(t.cast_members) cm
                WHERE lower(cm->>'name') = needle
              ) THEN 'Cast' ELSE NULL END
            ) AS role_in_film
          FROM public.titles t
          WHERE t.person_names @> ARRAY[needle]
            AND (t.is_public OR (SELECT auth.role()) = 'authenticated')
          ORDER BY t.id, t.is_featured DESC NULLS LAST,
                   t.is_active DESC, t.popularity DESC NULLS LAST
          LIMIT max_results;
        END;
        $function$;

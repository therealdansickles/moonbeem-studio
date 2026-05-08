-- search_titles_admin RPC for the partner-attribution modal on
-- /admin. Mirrors the existing public search_titles RPC's index
-- alignment (`lower(title) LIKE '%' || lower(query) || '%'`) so the
-- pre-existing GIN trigram index on `lower(title)` is used. Without
-- this RPC, the JS client's ILIKE filter targets the raw title
-- column expression and the planner falls back to a parallel seq
-- scan (~26s on the 1.4M-row catalog).
--
-- Returned columns are admin-scoped (partner_id, is_active,
-- is_public, deleted_at) — the public search_titles RPC doesn't
-- expose these. Soft-deleted titles are excluded server-side.
--
-- SECURITY DEFINER + EXECUTE granted to authenticated only. The
-- API route layer (/api/admin/titles/search) gates on
-- requireSuperAdmin before invoking, so non-super-admins never
-- reach this RPC.

create or replace function public.search_titles_admin(
  query text,
  max_results integer default 20
)
returns table(
  id uuid,
  slug text,
  title text,
  year integer,
  partner_id uuid,
  is_active boolean,
  is_public boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pattern text := '%' || lower(query) || '%';
begin
  return query
  select
    t.id,
    t.slug,
    t.title,
    t.year,
    t.partner_id,
    t.is_active,
    t.is_public
  from public.titles t
  where lower(t.title) like v_pattern
    and t.deleted_at is null
  order by t.year desc nulls last, t.title asc
  limit greatest(1, least(max_results, 50));
end;
$$;

revoke execute on function public.search_titles_admin(text, integer) from public;
grant execute on function public.search_titles_admin(text, integer) to authenticated;

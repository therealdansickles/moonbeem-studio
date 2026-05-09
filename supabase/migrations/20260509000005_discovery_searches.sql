-- discovery_searches: per-invocation log of EnsembleData search
-- queries triggered from the Discover tab on /admin/titles/[slug].
--
-- One row per server-side search call. Reads per-title (which queries
-- have been run, how many units burned), and aggregate (how many
-- units/day across the platform — Wood plan caps at 1500/day).
-- Display surface is followup; logging starts now so we have history
-- when the analytics page lands.
--
-- units_estimated stores our best-guess cost (1 unit per 20 results
-- on TikTok keyword search per Wood plan), not the authoritative
-- charge from EnsembleData. Authoritative cost requires reading
-- units_charged from each response — which we could store later in
-- a result_meta jsonb column without breaking existing rows.
--
-- Service-role only. RLS is enabled but no policies are added — the
-- /admin pages render server-side via service role and the API
-- routes already gate super_admin.

create table if not exists public.discovery_searches (
  id uuid primary key default gen_random_uuid(),
  title_id uuid references public.titles(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  platform text not null
    check (platform in ('tiktok', 'instagram', 'twitter')),
  query text not null,
  period text not null
    check (period in ('1d', '7d', '30d', '90d', '180d', 'all')),
  max_results integer not null check (max_results > 0),
  results_count integer not null default 0,
  units_estimated numeric not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists discovery_searches_title_id_at_idx
  on public.discovery_searches (title_id, created_at desc);

create index if not exists discovery_searches_created_at_idx
  on public.discovery_searches (created_at desc);

alter table public.discovery_searches enable row level security;

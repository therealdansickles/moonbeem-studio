-- Gating Phase 2: user_events — the full per-action analytics ledger.
--
-- Distinct from user_action_counts (the quota cache, one row per
-- user x capability, read on the gate-check hot path). user_events
-- is append-only, one row per action, with metadata — the source of
-- truth for network analytics, partner dashboards, case studies, and
-- future attribution. It can grow large without touching gate-check
-- latency (those stay PK lookups on user_action_counts).
--
-- Phase 2 event_types: download_clip, download_still, save_to_top12,
-- remove_from_top12, verify_social. (purchase_rental is reserved but
-- not yet wired — no on-platform purchase flow exists.)
--
-- Logging is best-effort and fail-soft (see logUserEvent): a failed
-- insert never breaks the user action. Super-admins ARE logged here
-- (the ledger is who-did-what); only quota tracking excludes them.
-- Anonymous actions are not logged (no user_id to attach).

create table public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  event_type text not null,
  resource_type text,
  resource_id text,
  title_id uuid,
  tier_at_event text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index idx_user_events_user_time
  on public.user_events (user_id, created_at desc);
create index idx_user_events_resource
  on public.user_events (resource_type, resource_id);
create index idx_user_events_title
  on public.user_events (title_id);
create index idx_user_events_type_time
  on public.user_events (event_type, created_at desc);

alter table public.user_events enable row level security;

create policy "users read own events"
  on public.user_events for select
  using (user_id = auth.uid());

create policy "service role writes events"
  on public.user_events for all
  using (auth.jwt() ->> 'role' = 'service_role');

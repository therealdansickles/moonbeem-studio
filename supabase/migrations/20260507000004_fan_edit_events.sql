-- Stage B3: per-fan-edit user-action tracking.
--
-- Captures modal opens, closes (with duration), and "View on
-- platform" outbound clicks. Distinct from public.external_clicks
-- (which is purpose-built for affiliate-link / title-offer clicks
-- and feeds /admin/clicks rollups) — keeping fan_edit events in
-- their own table avoids polluting affiliate analytics queries.
--
-- Cardinality is per-user-action: every modal open + close pair
-- writes 2 rows; "view on platform" adds another. With 58 active
-- fan_edits and modest traffic, expected scale is thousands of rows
-- per day at peak — fine for Postgres without partitioning.
--
-- Auth: user_id is nullable (anonymous viewers count too); when the
-- viewer is signed in, the API route fills it from auth.users.id
-- via the public.users mirror.
--
-- session_id is a client-generated UUID per modal-open session,
-- correlating the open + close + any click events from that session.
-- Not a security primitive — purely for read-side correlation.

create table if not exists public.fan_edit_events (
  id uuid primary key default gen_random_uuid(),
  fan_edit_id uuid not null references public.fan_edits(id) on delete cascade,
  event_type text not null
    check (event_type in (
      'modal_open',
      'modal_close',
      'view_on_platform_click'
    )),
  -- Set only on modal_close events: how long the modal was open in ms.
  duration_ms integer,
  user_id uuid references public.users(id) on delete set null,
  session_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table public.fan_edit_events enable row level security;
-- No policies. Reads + writes go through the API routes using the
-- service-role client; direct PostgREST access is denied by default
-- under RLS, matching the convention used by external_clicks/tips.

-- Fast aggregation per fan_edit (admin stats endpoint), and recency
-- sort for an eventual activity feed.
create index if not exists idx_fan_edit_events_fan_edit_id_created
  on public.fan_edit_events (fan_edit_id, created_at desc);

-- Sparse index — only signed-in events. Supports per-user analytics
-- without bloating the index for the (much larger) anonymous tail.
create index if not exists idx_fan_edit_events_user_id
  on public.fan_edit_events (user_id)
  where user_id is not null;

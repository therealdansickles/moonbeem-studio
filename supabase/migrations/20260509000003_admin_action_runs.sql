-- admin_action_runs: per-invocation log of /admin Quick actions.
--
-- Drives the "last run" timestamp + result summary surfaced on the
-- /admin landing page next to each Quick action button. One row per
-- click of an action; we read the latest per action_key when
-- rendering /admin.
--
-- Service-role only. RLS is enabled but no policies are added — the
-- service-role key writes from the API route handlers, and reads
-- happen via the same client in the server-rendered page. No anon /
-- authenticated path needs visibility.

create table if not exists public.admin_action_runs (
  id uuid primary key default gen_random_uuid(),
  action_key text not null,
  triggered_by uuid references auth.users(id) on delete set null,
  triggered_at timestamptz not null default now(),
  duration_ms integer,
  ok boolean not null,
  result jsonb,
  error_message text
);

create index if not exists admin_action_runs_action_key_at_idx
  on public.admin_action_runs (action_key, triggered_at desc);

alter table public.admin_action_runs enable row level security;

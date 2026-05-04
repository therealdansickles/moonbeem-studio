-- Block C: notification log + per-user preferences for title-update emails.
--
-- TODO (Block-D2): migrate to a queued send pipeline. The upload route
-- currently fires notifyTitleRequesters() synchronously and awaits the
-- Resend API. For >50 requesters per title or transient Resend
-- failures, this should move to a job queue (pg_cron + dispatch table,
-- or a worker-side queue).
--
-- TODO (Block-C-followup): the admin upload UI fires one POST per file
-- (src/app/admin/titles/[slug]/upload/UploadClient.tsx), so an admin
-- uploading 3 clips at once produces 3 separate notify calls and 3
-- emails per requester. Spec calls for one email per upload event. Fix
-- by either client-side batching (gather IDs, single notify call) or
-- server-side debounce (suppress sends within N seconds of a prior log
-- row for same user+title+content_type).
--
-- TODO (Block-C-followup): fan_edits has no admin insert route today
-- (only SQL seeds and scripts/backfill_fan_edit_oembed.mjs). When an
-- insert path is added, call notifyTitleRequesters with
-- contentType:'fan_edit' after the insert — the helper already
-- supports it.

-- Add request_type to existing title_requests so the schema is ready
-- to split into 'fan_edits' vs 'clips_and_stills' later. The UI
-- currently exposes only the fan-edits button; existing rows get the
-- default automatically and need no backfill.
alter table public.title_requests
  add column if not exists request_type text not null
  default 'fan_edits'
  check (request_type in ('fan_edits', 'clips_and_stills'));

create index if not exists idx_title_requests_type
  on public.title_requests(request_type);

create table public.notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  email_on_title_updates boolean not null default true,
  -- Rotating this token (update ... set unsubscribe_token =
  -- gen_random_uuid()) is the revocation path if a user forwards an
  -- email containing their unsubscribe link.
  unsubscribe_token uuid not null default gen_random_uuid() unique,
  updated_at timestamptz not null default now()
);

create trigger set_updated_at_notification_preferences
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

alter table public.notification_preferences enable row level security;

create policy notification_preferences_self_read
  on public.notification_preferences for select
  using (auth.uid() = user_id);

create policy notification_preferences_self_update
  on public.notification_preferences for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy notification_preferences_self_insert
  on public.notification_preferences for insert
  with check (auth.uid() = user_id);

create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  content_type text not null check (content_type in ('clip','still','fan_edit')),
  content_ids uuid[] not null,
  resend_message_id text,
  status text not null check (status in ('sent','failed')),
  error_text text,
  sent_at timestamptz not null default now()
);

create index idx_notification_log_user_title_sent
  on public.notification_log (user_id, title_id, sent_at desc);

-- Idempotency: notify endpoint pre-filters via gin overlap (&&) on
-- content_ids so a re-sent batch with overlapping IDs skips already-
-- notified users.
create index idx_notification_log_content_ids_gin
  on public.notification_log using gin (content_ids);

alter table public.notification_log enable row level security;

create policy notification_log_super_admin_read
  on public.notification_log for select
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );
-- Writes are service-role only (bypasses RLS — no insert policy needed).

-- Admin "Requests" dashboard aggregation. tr.requested_at per
-- migration 20260430000001 (NOT created_at). Grouped by request_type
-- so the dashboard can split fan-edit vs clips-and-stills counts once
-- the second CTA is exposed.
create or replace view public.admin_title_request_stats as
select
  tr.title_id,
  tr.request_type,
  t.slug,
  t.title,
  count(*)::int as request_count,
  max(tr.requested_at) as latest_request_at
from public.title_requests tr
join public.titles t on t.id = tr.title_id
group by tr.title_id, tr.request_type, t.slug, t.title;

grant select on public.admin_title_request_stats to authenticated;

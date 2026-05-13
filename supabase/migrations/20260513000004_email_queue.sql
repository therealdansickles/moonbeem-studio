-- email_queue: durable workflow state for outbound notification emails.
--
-- Problem this solves: the current notifyTitleRequesters() loop awaits
-- Resend round-trips serially inside admin upload routes. At
-- ~500ms/email × 60+ requesters this approaches the Vercel function
-- timeout (30s on Hobby/Pro). Today's max requester count is 3, but
-- the migration anticipates the political-vertical scale conversation.
-- See feedback_supabase_bulk_operations.md for the related
-- "infrastructure for pre-incident scale" pattern.
--
-- Lifecycle:
--   1. Admin upload (clips/stills/fan_edit insert hook) INSERTs queue
--      rows synchronously — fast, returns response immediately.
--   2. The same handler triggers an after()/waitUntil() drain on the
--      hot path: drainQueue() picks up newly-pending rows, sends
--      emails, marks rows sent.
--   3. Failure path: drainQueue catches Resend errors, increments
--      attempts, computes next_retry_at via exponential backoff,
--      leaves status='pending'.
--   4. Vercel cron (every 5 min) sweeps any pending rows where
--      next_retry_at <= now() — catches rows missed by hot-path
--      drain (cold-start mid-flight, transient Resend outage, etc.).
--   5. After max attempts (5), status flips to 'failed_permanently'
--      and the row stops being retried.
--
-- Relationship to notification_log:
--   notification_log is the final audit row — "we sent (or tried to
--   send) this email." email_queue is workflow state — "we plan to
--   send this and are tracking retries." A successful send writes to
--   both: notification_log (audit) + email_queue.status='sent' (workflow
--   marker for later observability / replay).
--
-- RLS: super-admin SELECT for an /admin/email-queue page (followup).
-- Writes are service-role only (no policies needed; service-role
-- bypasses RLS).

create table public.email_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  content_type text not null check (content_type in ('clip', 'still', 'fan_edit')),
  content_ids uuid[] not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed_permanently')),
  attempts integer not null default 0,
  next_retry_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

-- Hot-path drain query: pending rows due for processing.
-- Partial index keeps the index small as 'sent' rows accumulate.
create index idx_email_queue_pending_due
  on public.email_queue (next_retry_at)
  where status = 'pending';

-- Admin observability / replay queries.
create index idx_email_queue_status_created
  on public.email_queue (status, created_at desc);

create trigger set_updated_at_email_queue
  before update on public.email_queue
  for each row execute function public.set_updated_at();

alter table public.email_queue enable row level security;

create policy email_queue_super_admin_read
  on public.email_queue for select
  using (
    exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'super_admin'
    )
  );

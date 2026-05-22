-- Campaigns v1 (3c.1): metering-engine schema — campaign_metering_runs
-- and campaign_metering_deltas.
--
-- 3c is the metering engine: it turns funded campaign pools into
-- campaign-tagged creator_earnings rows. 3c.1 (this migration) is the
-- SCHEMA sub-stage only — two new tables plus their lockdown. It adds
-- NO metering-job logic (3c.2) and NO status-lifecycle logic (3c.3);
-- those sub-stages fill in jobs/RPCs against the tables defined here.
--
-- THE MODEL (locked decisions from the 3c recon)
--
--   A "delta" is the new views a fan_edit gained between two
--   view_tracking_snapshots. The view-tracking pipeline already
--   captures a snapshot per fan_edit roughly every 20h. 3c meters at
--   per-snapshot grain: exactly one campaign_metering_deltas row per
--   (campaign_id, fan_edit_id, snapshot_id).
--
--   Attribution is FIFO by campaigns.funded_at — the oldest funded
--   eligible campaign covering a fan_edit's title bills each delta
--   until its pool is exhausted, then the next. Eligibility is
--   campaign.status IN ('funded','live'); 'paused' and 'completed'
--   are excluded. The campaign window is lifecycle-driven (funded_at
--   -> pool exhaustion); starts_at / ends_at are NOT consulted in 3c.
--
--   Pricing uses campaigns.cpm_rate_cents (the campaign's own CPM),
--   never partner_title_rates.
--
--   Settling: a delta "appears" at its snapshot's captured_at
--   (appeared_at) and becomes payable settling_days later
--   (settles_at). Until settles_at passes the delta is 'unsettled'.
--   Settling state lives HERE, never on creator_earnings — a
--   campaign-tagged creator_earnings row is written ONLY at
--   settlement, born already-payable, so the existing (campaign-
--   blind) creator withdraw rail needs no changes.
--
-- THE TWO TABLES
--
--   campaign_metering_deltas — one row per metered delta. The
--     authoritative record of every delta the metering job has seen.
--     Status lifecycle:
--       unsettled -> settled -> billed
--                            -> voided
--     'unsettled' : inside the settling window (settles_at in future).
--     'settled'   : settles_at has passed; eligible to bill.
--     'billed'    : a creator_earnings row + a campaign_ledger debit
--                   have been written for it — creator_earning_id,
--                   prorata_run_id and prorata_factor are all set.
--     'voided'    : the campaign reached 'completed' before this row
--                   could bill (pool exhausted by faster-billing
--                   rows, or campaign paused/cancelled). Set by 3c.3.
--
--   campaign_metering_runs — one row per metering-job invocation.
--     Audit trail plus the per-run pro-rata factor.
--
-- NON-OBVIOUS INVARIANTS
--
--   1. full_cpm_cents is recorded at FULL campaign CPM, always —
--      floor((delta_views / 1000) * campaigns.cpm_rate_cents). When a
--      campaign's pool cannot cover everything settling in a run, the
--      shortfall is recorded as a pro-rata SCALING FACTOR
--      (prorata_factor, 0 < f <= 1), NOT by reducing the recorded
--      delta. A delta row always tells the truth about how many views
--      happened and what they were worth at full rate; the factor
--      tells you what fraction the pool actually paid. The billed
--      creator_earnings.earnings_cents is
--      floor(full_cpm_cents * prorata_factor).
--
--   2. prorata_factor is stored in two places by design — on the run
--      (the factor for that whole run) and on each delta the run
--      billed (the factor applied to that specific row). They are
--      equal for a normally-billed row; the per-row copy lets a
--      single delta be audited without joining back to its run.
--
--   3. The UNIQUE (campaign_id, fan_edit_id, snapshot_id) index makes
--      the metering job idempotent — a re-run cannot double-insert
--      the same delta.
--
--   4. settles_at is a plain stored column, not generated — it
--      depends on campaigns.settling_days (a different table), which
--      a generated column cannot reference. The 3c.2 job computes it
--      (appeared_at + settling_days) at insert time.
--
-- LOCKDOWN
--
--   Both tables are written and read only by the service-role client
--   (the metering job and its RPCs). RLS is enabled with no policies,
--   and grants are explicit — revoked from public / anon /
--   authenticated, granted to service_role — mirroring 3b's Stage 1.5
--   lockdown discipline rather than relying on Supabase default
--   privileges. The creator-authenticated withdraw rail reads
--   creator_earnings only and never touches metering state.
--
-- updated_at: campaign_metering_deltas is mutable (status flips,
-- billing fields get stamped) so it gets a BEFORE UPDATE trigger
-- wired to the existing public.set_updated_at() function, matching
-- campaigns / campaign_funding / partner_credits. campaign_metering_runs
-- has no updated_at column (short append-then-finalize lifecycle) and
-- therefore no trigger.

-- ---------------------------------------------------------------
-- 1. campaign_metering_runs
-- ---------------------------------------------------------------
-- Created first: campaign_metering_deltas.prorata_run_id references
-- it.

create table if not exists public.campaign_metering_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- The campaign this run processed. Nullable: a NULL would mean a
  -- global multi-campaign run. In practice pro-rata is per-campaign
  -- (a run's single prorata_factor only makes sense against one
  -- campaign's pool), so 3c.2 is expected to scope a run per
  -- campaign; the NULL/global case is left open, not yet needed.
  campaign_id uuid references public.campaigns(id),
  -- The factor applied to all rows billed in this run. NULL means no
  -- pro-rata (every row billed at full CPM).
  prorata_factor numeric(10, 9)
    check (prorata_factor is null or (prorata_factor > 0 and prorata_factor <= 1)),
  rows_billed integer not null default 0,
  total_billed_cents integer not null default 0,
  pool_remaining_before_cents integer,
  pool_remaining_after_cents integer,
  status text not null default 'running',
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.campaign_metering_runs
  drop constraint if exists campaign_metering_runs_status_check;

alter table public.campaign_metering_runs
  add constraint campaign_metering_runs_status_check
  check (status in ('running', 'completed', 'failed'));

create index if not exists idx_campaign_metering_runs_campaign_started
  on public.campaign_metering_runs (campaign_id, started_at desc);

alter table public.campaign_metering_runs enable row level security;
-- No policies. Service-role only (see Grants section below).

-- ---------------------------------------------------------------
-- 2. campaign_metering_deltas
-- ---------------------------------------------------------------

create table if not exists public.campaign_metering_deltas (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id),
  fan_edit_id uuid not null references public.fan_edits(id),
  -- The snapshot that produced this delta (the "current" one).
  snapshot_id uuid not null references public.view_tracking_snapshots(id),
  -- The snapshot the delta was computed against. NULL if this was a
  -- baseline (no prior snapshot existed for this fan_edit in the
  -- campaign window).
  prior_snapshot_id uuid references public.view_tracking_snapshots(id),
  delta_views integer not null check (delta_views >= 0),
  -- What this delta would earn at full campaign CPM, before any
  -- pro-rata scaling. Computed at delta-creation time:
  -- floor((delta_views / 1000) * campaigns.cpm_rate_cents).
  full_cpm_cents integer not null check (full_cpm_cents >= 0),
  -- captured_at of the snapshot that produced this delta.
  appeared_at timestamptz not null,
  -- appeared_at + (campaigns.settling_days days), computed at insert.
  settles_at timestamptz not null,
  status text not null default 'unsettled',
  -- Set when status flips to 'billed': the resulting earnings row.
  creator_earning_id uuid references public.creator_earnings(id),
  -- Set with creator_earning_id: the metering run that billed it.
  prorata_run_id uuid references public.campaign_metering_runs(id),
  -- The factor applied at billing (1.0 = full CPM, 0.25 = 25%). Set
  -- when status flips to 'billed'.
  prorata_factor numeric(10, 9)
    check (prorata_factor is null or (prorata_factor > 0 and prorata_factor <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaign_metering_deltas
  drop constraint if exists campaign_metering_deltas_status_check;

alter table public.campaign_metering_deltas
  add constraint campaign_metering_deltas_status_check
  check (status in ('unsettled', 'settled', 'billed', 'voided'));

-- Idempotency: prevents a double-insert if the metering job runs
-- twice over the same (campaign, fan_edit, snapshot).
create unique index if not exists campaign_metering_deltas_snapshot_unique
  on public.campaign_metering_deltas (campaign_id, fan_edit_id, snapshot_id);

-- The metering job's daily picker: "all rows whose settles_at has
-- passed" — finds unsettled rows ready to flip to settled/billed.
create index if not exists idx_campaign_metering_deltas_status_settles
  on public.campaign_metering_deltas (status, settles_at);

-- Pool-balance queries and per-campaign auditing.
create index if not exists idx_campaign_metering_deltas_campaign_status
  on public.campaign_metering_deltas (campaign_id, status);

-- Audit: "show me every metering row for this fan_edit".
create index if not exists idx_campaign_metering_deltas_fan_edit
  on public.campaign_metering_deltas (fan_edit_id);

alter table public.campaign_metering_deltas enable row level security;
-- No policies. Service-role only (see Grants section below).

drop trigger if exists set_updated_at_campaign_metering_deltas
  on public.campaign_metering_deltas;
create trigger set_updated_at_campaign_metering_deltas
  before update on public.campaign_metering_deltas
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- 3. Grants — service-role only
-- ---------------------------------------------------------------
-- Explicit lockdown, mirroring 3b's Stage 1.5 discipline: do not
-- rely on Supabase default privileges. Both tables are written and
-- read only by the service-role client (the metering job + its
-- RPCs). public, anon and authenticated get nothing.

revoke all on public.campaign_metering_runs from public, anon, authenticated;
revoke all on public.campaign_metering_deltas from public, anon, authenticated;

grant all on public.campaign_metering_runs to service_role;
grant all on public.campaign_metering_deltas to service_role;

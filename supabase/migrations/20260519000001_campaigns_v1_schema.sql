-- Campaigns v1 schema migration.
--
-- Direction: EXTEND. Campaigns reuse the existing partner_title_rates /
-- creator_earnings engine. One earnings ledger.
--
-- This migration is purely additive: five new tables, two new columns
-- on existing tables (creator_earnings.campaign_id, partners.stripe_customer_id),
-- and a default-value change on titles.moonbeem_take_rate_pct
-- (0.15 -> 0.10 for new rows; existing rows are NOT backfilled).
--
-- The one piece of subtlety: creator_earnings's existing UNIQUE
-- INDEX `creator_earnings_per_day_unique` on
-- (creator_id, fan_edit_id, calculation_date) is dropped and replaced
-- with ONE non-partial UNIQUE index on four columns with
-- NULLS NOT DISTINCT:
--
--   UNIQUE (creator_id, fan_edit_id, calculation_date, campaign_id)
--   NULLS NOT DISTINCT
--
-- NULLS NOT DISTINCT (Postgres 15+; this project runs 17) makes two
-- NULL campaign_ids collide for uniqueness, so legacy rows
-- (campaign_id IS NULL) retain three-column uniqueness exactly as
-- before. NULL vs a real campaign_id still compares distinct, so a
-- legacy row and a campaign row for the same (creator, edit, date)
-- coexist. Two campaign rows in different campaigns for the same
-- (creator, edit, date) also coexist (different non-null campaign_ids).
--
-- This single index is inferable by ON CONFLICT (creator_id,
-- fan_edit_id, calculation_date, campaign_id) — no partial-index
-- WHERE predicate to specify, so supabase-js .upsert() works with a
-- four-column onConflict string. src/lib/earnings-calc.ts only needs
-- campaign_id added to its insert payload (NULL for legacy) and to
-- its onConflict string; that follow-up is a small code change, not
-- a 42P10 trap.
--
-- The legacy index is a UNIQUE INDEX (not a UNIQUE CONSTRAINT) per
-- the source migration 20260508000004_earnings_foundation.sql:75-76
-- — so the correct DDL here is `drop index`, not `alter table drop
-- constraint`.
--
-- RLS: enabled on every new table, with NO policies. Service-role
-- only, matching the creator_payout_accounts / withdrawals /
-- external_clicks / tips convention.
--
-- updated_at: campaigns, campaign_funding, partner_credits each get a
-- BEFORE UPDATE trigger wired to the existing public.set_updated_at()
-- function (defined in 20260424000001_initial_schema.sql). The two
-- append-only tables (campaign_titles, campaign_ledger) have no
-- updated_at column and no trigger.

-- ---------------------------------------------------------------
-- B1. campaigns
-- ---------------------------------------------------------------

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  name text not null,
  status text not null default 'draft',
  cpm_rate_cents integer not null,
  budget_pool_cents integer not null,
  settling_days integer not null default 7,
  moonbeem_fee_pct numeric not null default 0.10,
  starts_at timestamptz,
  ends_at timestamptz,
  funded_at timestamptz,
  launched_at timestamptz,
  completed_at timestamptz,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaigns
  drop constraint if exists campaigns_status_check;

alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('draft', 'funded', 'live', 'paused', 'completed'));

create index if not exists idx_campaigns_partner_id
  on public.campaigns (partner_id);

create index if not exists idx_campaigns_status
  on public.campaigns (status);

alter table public.campaigns enable row level security;
-- No policies. Reads + writes go through API routes using the
-- service-role client.

drop trigger if exists set_updated_at_campaigns on public.campaigns;
create trigger set_updated_at_campaigns
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- B2. campaign_titles (M2M)
-- ---------------------------------------------------------------

create table if not exists public.campaign_titles (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  title_id uuid not null references public.titles(id),
  created_at timestamptz not null default now(),
  unique (campaign_id, title_id)
);

create index if not exists idx_campaign_titles_title_id
  on public.campaign_titles (title_id);

alter table public.campaign_titles enable row level security;
-- No policies. Service-role only.

-- ---------------------------------------------------------------
-- B3. campaign_funding (money in)
-- ---------------------------------------------------------------

create table if not exists public.campaign_funding (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id),
  amount_cents integer not null check (amount_cents > 0),
  fee_cents integer not null check (fee_cents >= 0),
  stripe_payment_intent_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaign_funding
  drop constraint if exists campaign_funding_status_check;

alter table public.campaign_funding
  add constraint campaign_funding_status_check
  check (status in ('pending', 'succeeded', 'failed'));

-- Partial unique on stripe_payment_intent_id, mirroring the
-- withdrawals.stripe_transfer_id pattern from
-- 20260508000005_payouts_foundation.sql:81-82.
create unique index if not exists campaign_funding_stripe_payment_intent_unique
  on public.campaign_funding (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index if not exists idx_campaign_funding_campaign
  on public.campaign_funding (campaign_id);

alter table public.campaign_funding enable row level security;
-- No policies. Service-role only.

drop trigger if exists set_updated_at_campaign_funding on public.campaign_funding;
create trigger set_updated_at_campaign_funding
  before update on public.campaign_funding
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- B4. campaign_ledger (append-only)
-- ---------------------------------------------------------------
-- Append-only is enforced at the application layer in v1; no
-- update/delete triggers in this migration. amount_cents is signed
-- (no >0 check) because refunds and adjustments may be negative.

create table if not exists public.campaign_ledger (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id),
  entry_type text not null,
  amount_cents integer not null,
  creator_earning_id uuid references public.creator_earnings(id),
  campaign_funding_id uuid references public.campaign_funding(id),
  note text,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.campaign_ledger
  drop constraint if exists campaign_ledger_entry_type_check;

alter table public.campaign_ledger
  add constraint campaign_ledger_entry_type_check
  check (entry_type in ('funding', 'payout', 'refund', 'adjustment'));

-- Primary read pattern: SUM over a campaign's ledger entries to
-- compute remaining balance.
create index if not exists idx_campaign_ledger_campaign
  on public.campaign_ledger (campaign_id);

create index if not exists idx_campaign_ledger_creator_earning
  on public.campaign_ledger (creator_earning_id)
  where creator_earning_id is not null;

create index if not exists idx_campaign_ledger_funding
  on public.campaign_ledger (campaign_funding_id)
  where campaign_funding_id is not null;

alter table public.campaign_ledger enable row level security;
-- No policies. Service-role only.

-- ---------------------------------------------------------------
-- B5. partner_credits
-- ---------------------------------------------------------------

create table if not exists public.partner_credits (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id),
  amount_cents integer not null check (amount_cents > 0),
  remaining_cents integer not null check (remaining_cents >= 0),
  source_campaign_id uuid references public.campaigns(id),
  applied_to_campaign_id uuid references public.campaigns(id),
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.partner_credits
  drop constraint if exists partner_credits_status_check;

alter table public.partner_credits
  add constraint partner_credits_status_check
  check (status in ('available', 'partially_applied', 'depleted', 'refunded'));

create index if not exists idx_partner_credits_partner
  on public.partner_credits (partner_id);

create index if not exists idx_partner_credits_available
  on public.partner_credits (partner_id)
  where status in ('available', 'partially_applied');

alter table public.partner_credits enable row level security;
-- No policies. Service-role only.

drop trigger if exists set_updated_at_partner_credits on public.partner_credits;
create trigger set_updated_at_partner_credits
  before update on public.partner_credits
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------
-- B6. creator_earnings.campaign_id + composite-key swap
-- ---------------------------------------------------------------

alter table public.creator_earnings
  add column if not exists campaign_id uuid references public.campaigns(id);

-- Drop the legacy three-column unique INDEX (not a constraint —
-- see header comment). Replaced below by one four-column index with
-- NULLS NOT DISTINCT.
drop index if exists public.creator_earnings_per_day_unique;

-- Single index covering both legacy and campaign uniqueness via
-- NULLS NOT DISTINCT (Postgres 15+):
--   - legacy + legacy at same (creator, edit, date): two NULL
--     campaign_ids collide -> uniqueness preserved (identical to
--     the dropped index's behavior).
--   - campaign + campaign in same campaign at same (creator, edit,
--     date): non-null equality -> uniqueness preserved.
--   - legacy + campaign at same (creator, edit, date): NULL vs
--     real UUID -> distinct -> coexist.
--   - two campaigns at same (creator, edit, date): different
--     non-null UUIDs -> distinct -> coexist.
-- ON CONFLICT (creator_id, fan_edit_id, calculation_date,
-- campaign_id) infers this index cleanly — supabase-js .upsert()
-- works with the four-column onConflict string.
create unique index if not exists creator_earnings_per_day_unique
  on public.creator_earnings
    (creator_id, fan_edit_id, calculation_date, campaign_id)
  nulls not distinct;

-- ---------------------------------------------------------------
-- B7. partners.stripe_customer_id
-- ---------------------------------------------------------------

alter table public.partners
  add column if not exists stripe_customer_id text;

-- ---------------------------------------------------------------
-- B8. titles.moonbeem_take_rate_pct default 0.15 -> 0.10
-- ---------------------------------------------------------------
-- Phase A confirmed no application code reads this column; the only
-- references are in 20260508000004_earnings_foundation.sql (the
-- migration that created it). Default change only — existing rows
-- keep their 0.15 value. Dropping the column is a separate decision
-- once confirmed fully unused.

alter table public.titles
  alter column moonbeem_take_rate_pct set default 0.10;

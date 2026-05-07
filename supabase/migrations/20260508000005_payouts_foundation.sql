-- Stage 4 Part 2: payouts foundation (Stripe Connect, creator-
-- initiated withdrawals).
--
-- Yesterday's migration (20260508000004_earnings_foundation) added
-- creator_earnings — the ledger of what each creator has earned.
-- This migration makes those earnings withdrawable:
--
--   creator_payout_accounts: 1-to-1 with creators. Stores the
--     Stripe Connect account id once a creator starts onboarding.
--     onboarding_completed flips when Stripe redirects back to us
--     post-form; payouts_enabled flips when Stripe verifies the
--     account (capabilities = "active") via webhook.
--
--   withdrawals: one row per creator-initiated cash-out. Status
--     transitions pending → completed (on transfer.created
--     webhook) or pending → failed (on transfer.failed). v1
--     "withdraw all" semantics: amount_cents equals the sum of
--     unwithdrawn creator_earnings at the time of the request.
--
--   creator_earnings.withdrawn_at: set when the row's earnings
--     have been included in a successful withdrawal. NULL means
--     "available balance." Reconciles to withdrawals.completed_at
--     by timestamp (no FK in v1; partial-withdrawal support in v2
--     would add withdrawal_id here).
--
-- Idempotency: the withdrawal route will use withdrawals.id as
-- the Stripe Idempotency-Key when calling Transfers — built in
-- the API layer, no schema concern here.

-- ---------------------------------------------------------------
-- creator_payout_accounts
-- ---------------------------------------------------------------

create table if not exists public.creator_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  stripe_connect_account_id text not null,
  onboarding_completed boolean not null default false,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists creator_payout_accounts_creator_unique
  on public.creator_payout_accounts (creator_id);

-- Stripe account id is also unique — one Connect account never
-- maps to two creators. Defensive against bad data, also lets
-- the webhook handler look up the row by stripe_connect_account_id.
create unique index if not exists creator_payout_accounts_stripe_account_unique
  on public.creator_payout_accounts (stripe_connect_account_id);

alter table public.creator_payout_accounts enable row level security;
-- No policies. Reads + writes go through API routes using the
-- service-role client, matching the convention used by
-- external_clicks/tips/creator_earnings.

-- ---------------------------------------------------------------
-- withdrawals
-- ---------------------------------------------------------------

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  stripe_transfer_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.withdrawals
  drop constraint if exists withdrawals_status_check;

alter table public.withdrawals
  add constraint withdrawals_status_check
  check (status in ('pending', 'completed', 'failed'));

-- Webhook handler looks up by stripe_transfer_id; sparse index
-- (only set after Stripe acknowledges the transfer).
create unique index if not exists withdrawals_stripe_transfer_id_unique
  on public.withdrawals (stripe_transfer_id) where stripe_transfer_id is not null;

create index if not exists idx_withdrawals_creator
  on public.withdrawals (creator_id, created_at desc);

create index if not exists idx_withdrawals_pending
  on public.withdrawals (creator_id) where status = 'pending';

alter table public.withdrawals enable row level security;

-- ---------------------------------------------------------------
-- creator_earnings: withdrawn_at column
-- ---------------------------------------------------------------

alter table public.creator_earnings
  add column if not exists withdrawn_at timestamptz;

-- Available-balance queries filter on withdrawn_at IS NULL by
-- creator_id; sparse index speeds the common path.
create index if not exists idx_creator_earnings_unwithdrawn
  on public.creator_earnings (creator_id) where withdrawn_at is null;

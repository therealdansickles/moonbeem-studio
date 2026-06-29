-- B1 — partner_payout_accounts: partner-side Stripe Connect payout onboarding.
-- INERT (no money moves in B1): this table only records a partner's Connect
-- Standard account id and its onboarding/verification flags. The release/transfer
-- leg (paying distributor_net_cents out of past-hold 'held' settlements) is B2.
--
-- Exact mirror of creator_payout_accounts (1:1 owner <-> one Connect account),
-- swapping creator_id -> partner_id. Service-role only: RLS enabled with NO
-- policies, matching creator_payout_accounts (all reads/writes go through the
-- service-role client in the partner-scoped routes, which are the auth gate).

create table public.partner_payout_accounts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners (id) on delete cascade,
  stripe_connect_account_id text not null,
  onboarding_completed boolean not null default false,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One payout account per partner (mirrors creator_payout_accounts_creator_unique):
-- makes the onboard route's "reuse existing / on-conflict refetch" correct.
create unique index partner_payout_accounts_partner_unique
  on public.partner_payout_accounts (partner_id);

-- One row per Connect account (mirrors creator_payout_accounts_stripe_account_unique):
-- makes the account.updated webhook's .eq("stripe_connect_account_id", id) unambiguous.
create unique index partner_payout_accounts_stripe_account_unique
  on public.partner_payout_accounts (stripe_connect_account_id);

-- Service-role only, no public access (mirrors creator_payout_accounts).
alter table public.partner_payout_accounts enable row level security;

-- Phase 3 — creator hosting tiers (billing). Money-adjacent schema only; NO
-- Stripe objects and NO money values are written here. Two additions:
--   1) creator_subscriptions — the source of truth for a creator's PAID tier.
--      Free = NO active row (default). getCreatorTier() reads this (NOT
--      creators.tier, which is a pre-existing clearance enum 'open'/'cleared'
--      and is left untouched).
--   2) creators.grandfathered_encode_minutes — the permanent-zero floor,
--      snapshotted once at launch (ruling: pre-tier hosted minutes are free
--      forever). Lives on creators because it must exist for EVERY creator,
--      including free ones with no subscription row. The gate reads
--      billable = max(0, view.encode_minutes - this floor) against the tier
--      allotment.

-- 1) creator_subscriptions. Deny-all RLS (service-role only), exactly like the
--    other creator_* tables (ruling Q1) — the webhook + tier reader use the
--    service-role client; authorization is application-layer.
create table public.creator_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  creator_id             uuid not null references public.creators(id) on delete cascade,
  tier                   text not null check (tier in ('solo','studio','pro')),
  status                 text not null
     check (status in ('active','trialing','past_due','canceled',
                        'incomplete','incomplete_expired','unpaid','paused')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_price_id        text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
-- One Stripe subscription = one row (webhook idempotency / upsert key).
create unique index uq_creator_subscriptions_stripe_sub
  on public.creator_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;
-- getCreatorTier() looks up a creator's live subscription by creator_id.
create index idx_creator_subscriptions_creator
  on public.creator_subscriptions (creator_id);
-- At most one ACTIVE/TRIALING subscription per creator — the tier must be
-- unambiguous. Upgrade/downgrade mutate the SAME Stripe subscription (same row),
-- so this never blocks a legitimate transition; it backstops a double-subscribe.
create unique index uq_creator_subscriptions_one_live
  on public.creator_subscriptions (creator_id)
  where status in ('active','trialing');
alter table public.creator_subscriptions enable row level security; -- deny-all

-- 2) The permanent-zero grandfather floor. NOT NULL default 0 so every creator
--    has a definite floor; the launch snapshot script sets it once from the
--    creator_storage_usage view. Never recomputed after launch.
alter table public.creators
  add column grandfathered_encode_minutes numeric not null default 0;

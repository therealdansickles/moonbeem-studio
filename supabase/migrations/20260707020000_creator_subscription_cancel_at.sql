-- creator_subscriptions.cancel_at — the flexible-billing scheduled-cancel
-- timestamp. In Stripe's flexible billing mode (our permanent shape;
-- cancel_at_period_end is deprecated there), a portal "cancel at period end"
-- sets cancel_at (a unix timestamp) and leaves cancel_at_period_end=false, so
-- the pending cancellation is invisible unless we persist cancel_at.
--
-- Additive + nullable: the live handler is oblivious until its code deploys
-- (schema-first, honoring merge-handler-first). reflectCreatorSubscription will
-- populate it (epoch→ISO) on the next subscription event; pending-cancel derives
-- from `cancel_at IS NOT NULL OR cancel_at_period_end`, and the re-fetch clears
-- it symmetrically on a renege (cancel_at → null).
alter table public.creator_subscriptions
  add column cancel_at timestamptz;

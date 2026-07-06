-- Applied to prod via apply_migration (recorded version 20260705234141); prefix
-- aligned so `db push` will not re-run it.
--
-- Receipts (Option A): capture the Stripe hosted receipt_url at webhook time so
-- the buyer's Library click path stays Stripe-free (stored URL -> link). Nullable;
-- pre-existing rows + any null are lazily backfilled on first click via the
-- stored stripe_payment_intent_id.
alter table public.entitlements
  add column receipt_url text;

comment on column public.entitlements.receipt_url is
  'Stripe Charge.receipt_url, captured at checkout.session.completed. NULL for pre-existing rows / capture misses; lazily backfilled on Library click via stripe_payment_intent_id.';

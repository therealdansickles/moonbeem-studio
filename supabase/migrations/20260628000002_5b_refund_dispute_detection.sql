-- Sub-unit 5b feeder (c): refund/dispute DETECTION for the payout rail.
--
-- Records that a charge was refunded or disputed so the (future) feeder-(b)
-- release step skips the row — the contract with (b) is the status flip ALONE.
-- Moves no money. Refund additionally revokes the buyer's access; dispute does
-- not (contested claim). Resolution events + post-payout clawback ('reversed')
-- are a manual runbook, NOT built here.
--
-- Inert/safe to apply: transaction_settlements + entitlements are both 0 rows.

-- A. transaction_settlements ------------------------------------------------
-- Pin payout_status to its value set (the column was deliberately left open in
-- 20260627000001 for 5b to define). 'reversed' is reserved for the manual
-- post-payout clawback path; unused by feeder (c).
alter table public.transaction_settlements
  add constraint transaction_settlements_payout_status_check
  check (payout_status in ('held', 'paid', 'refunded', 'disputed', 'reversed'));

-- When the row was flipped out of 'held'. refunded_at/disputed_at are set by the
-- webhook handlers; reversed_at is reserved for the manual clawback path.
alter table public.transaction_settlements
  add column refunded_at timestamptz,
  add column disputed_at timestamptz,
  add column reversed_at timestamptz;

-- B. entitlements -----------------------------------------------------------
-- revoked_at: set ONLY by the refund handler -> getActiveEntitlement excludes
--   the row, ending access. disputed_at: set by the dispute handler, access
--   unchanged. Both also act as the settle-pass race signal (a refund/dispute
--   that lands before the nightly settle writes the settlement row).
alter table public.entitlements
  add column revoked_at timestamptz,
  add column disputed_at timestamptz;

-- The refund/dispute join key: a Charge/Dispute event carries the payment_intent
-- (never our session id), so the handlers map PI -> entitlement here. Partial
-- unique (PI may be null in theory) both makes the join index-served and asserts
-- the 1:1 PI<->entitlement invariant.
create unique index entitlements_stripe_payment_intent_id_key
  on public.entitlements (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

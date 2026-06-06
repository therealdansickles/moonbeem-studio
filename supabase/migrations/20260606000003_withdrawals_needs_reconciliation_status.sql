-- FIX A — close the creator-withdrawal double-pay window with a blocking
-- reconciliation status.
--
-- A withdrawal moves money in two NON-atomic steps (not in one transaction):
--   1. stripe.transfers.create(...)  → money leaves the platform balance
--   2. stamp creator_earnings.withdrawn_at on the settled rows
-- If step 1 succeeds but step 2 fails, the route used to mark the withdrawal
-- 'completed' while the earnings stayed withdrawn_at NULL — so the creator
-- could withdraw again and re-pay the same earnings (double-pay). The route
-- now parks that row in 'needs_reconciliation' instead, and the re-entry guard
-- blocks the creator's future withdrawals until an admin clears it by hand
-- (docs/payout-reconciliation.md). FIX B (a structural
-- creator_earnings.withdrawal_id link + auto reconciler) is the durable
-- follow-up; this migration only adds the new allowed status value.
--
-- Additive + reversible. `withdrawals` is a tiny table; every existing row is
-- 'pending'/'completed'/'failed', so all pass the widened CHECK (trivial scan).
--
-- Reverse (ONLY once no row uses the new value):
--   ALTER TABLE public.withdrawals DROP CONSTRAINT withdrawals_status_check;
--   ALTER TABLE public.withdrawals ADD CONSTRAINT withdrawals_status_check
--     CHECK (status IN ('pending', 'completed', 'failed'));

ALTER TABLE public.withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;
ALTER TABLE public.withdrawals ADD CONSTRAINT withdrawals_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'needs_reconciliation'));

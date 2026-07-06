-- Applied to prod via apply_migration (recorded version 20260706001622); prefix
-- aligned so `db push` will not re-run it.
--
-- Harden grant_tip's EXECUTE grant to match the sibling money RPCs
-- (grant_entitlement, confirm_campaign_funding). grant_tip is SECURITY DEFINER
-- and mints a payout-bearing transaction_settlements row, so it must be callable
-- ONLY by the service role (the webhook uses createServiceRoleClient). Supabase's
-- default privileges grant EXECUTE to anon/authenticated on every new public
-- function, which would make grant_tip reachable via POST /rest/v1/rpc/grant_tip
-- and bypass Stripe — this revoke closes that. (Verified: anon/authenticated ->
-- has_function_privilege EXECUTE = false, service_role = true.)
revoke execute on function public.grant_tip(uuid, text, text, text, integer) from public;
revoke execute on function public.grant_tip(uuid, text, text, text, integer) from anon;
revoke execute on function public.grant_tip(uuid, text, text, text, integer) from authenticated;
grant execute on function public.grant_tip(uuid, text, text, text, integer) to service_role;

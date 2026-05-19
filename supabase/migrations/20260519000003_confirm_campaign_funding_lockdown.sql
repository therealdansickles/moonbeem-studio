-- Campaigns v1 (3b, Stage 1.5): lock confirm_campaign_funding to
-- service_role only.
--
-- The Stage 1 migration (20260519000002_campaigns_funding_rpc.sql)
-- did `revoke execute ... from public; grant execute ... to
-- service_role;`. This was not enough: Supabase ships project-level
-- ALTER DEFAULT PRIVILEGES that grant EXECUTE on every new public.*
-- function to anon and authenticated. `REVOKE ... FROM PUBLIC` only
-- removes the SQL-standard catch-all grant; it does NOT undo the
-- per-role grants those default privileges apply. After Stage 1, the
-- function was reachable via PostgREST by any signed-in user (or even
-- by anon), which would let a non-partner-admin call
-- confirm_campaign_funding(uuid) directly and force-fund a campaign
-- without any Stripe charge.
--
-- This migration explicitly revokes EXECUTE from anon and
-- authenticated. We also re-affirm the intended end state (FROM
-- public, TO service_role) so this migration applied to a fresh
-- database produces the correct grants without depending on the
-- prior file's wording.
--
-- Pre-existing scope (NOT in this migration's scope): find_title_-
-- duplicates and find_or_create_stub_creator have the same loose
-- anon/authenticated grants per their migrations. Those are
-- read/stub-create shaped (no money state) and are banked as a
-- separate follow-up audit slice. This migration touches only
-- confirm_campaign_funding because that one moves money state.
--
-- Idempotency: REVOKE ... FROM <role> is a no-op when the role has
-- no privilege. Safe to re-run.

revoke execute on function public.confirm_campaign_funding(uuid) from anon;
revoke execute on function public.confirm_campaign_funding(uuid) from authenticated;
revoke execute on function public.confirm_campaign_funding(uuid) from public;
grant execute on function public.confirm_campaign_funding(uuid) to service_role;

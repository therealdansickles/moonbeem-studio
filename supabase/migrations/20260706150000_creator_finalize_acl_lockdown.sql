-- ACL lockdown for mux_finalize_creator_asset_ready — the missing mirror of
-- the partner RPC's EXECUTE lock (20260622000002_mux_finalize_asset_ready.sql).
--
-- The creator finalize RPC shipped in 20260706120000 WITHOUT this revoke/grant.
-- Because Supabase grants EXECUTE to PUBLIC/anon/authenticated by default on
-- public-schema functions, and this function is SECURITY DEFINER (bypasses the
-- deny-all RLS on creator_* — ruling Q1), it was reachable directly via
-- PostgREST by anon: any caller who knows a creator_mux_ingest_jobs.id (the
-- mux-upload route returns it to the creator's browser) could forge a
-- creator_episodes row with an arbitrary playback id and flip the job to ready
-- — bypassing the Mux webhook signature verification AND the DRM-policy
-- fail-closed check. Webhook-only: lock EXECUTE to service_role (the webhook's
-- client), exactly as the partner twin and confirm_campaign_funding do.
--
-- Append-only follow-up: 20260706120000 is already applied to prod, so the fix
-- is a separate migration rather than a retroactive edit. revoke/grant are
-- idempotent, so a fresh db reset (which runs both) converges to the same lock.
revoke all on function public.mux_finalize_creator_asset_ready(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mux_finalize_creator_asset_ready(uuid, text, text)
  to service_role;

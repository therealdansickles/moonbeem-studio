-- Transactions sub-unit 3 — stamp entitlements.first_played_at at DB time,
-- exactly-once. PURELY ADDITIVE: one function; NO table/column change
-- (first_played_at already exists, nullable timestamptz).
--
-- The playback gate (POST /api/episodes/[id]/playback-token) calls this on a
-- transactional episode's first token-mint to ARM the 48h rental clock. It is the
-- money-adjacent write of sub-unit 3.
--
-- Idempotent / exactly-once: the conditional UPDATE (WHERE first_played_at IS
-- NULL) stamps on the first play and matches 0 rows (no-op) on every later play —
-- and is concurrency-safe (two simultaneous first-plays both see NULL, but only
-- one UPDATE wins; the other no-ops). Uses now() (DB time, NOT a JS Date) so the
-- 48h clock anchors to the database and can't skew across app servers. This is an
-- RPC precisely because PostgREST/supabase-js cannot set a column to now() in an
-- update — mirrors the grant_rental_entitlement money-write pattern.
--
-- The gate evaluates entitlement activeness on the PRE-stamp row, THEN calls this
-- (a never-played rental is active via the 30-day start clock; this stamp then
-- transitions it to the 48h play clock for subsequent mints).
create or replace function public.stamp_first_play(p_entitlement_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.entitlements
     set first_played_at = now()
   where id = p_entitlement_id
     and first_played_at is null;
$$;

-- LOCKDOWN (the grant_rental_entitlement / confirm_campaign_funding lesson:
-- Supabase ALTER DEFAULT PRIVILEGES re-grants EXECUTE to anon + authenticated on
-- every new public.* function — revoke from all three explicitly, then grant only
-- to service_role). The playback gate calls this via the service-role client.
revoke execute on function public.stamp_first_play(uuid) from public;
revoke execute on function public.stamp_first_play(uuid) from anon;
revoke execute on function public.stamp_first_play(uuid) from authenticated;
grant execute on function public.stamp_first_play(uuid) to service_role;

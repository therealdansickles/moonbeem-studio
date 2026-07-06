-- Phase 2 — creator storage meter. Unit = ENCODE-MINUTES (the unit Mux bills
-- storage in; ruling D1). Capture Mux encode metrics onto each creator_episode
-- at finalize (ruling D2), and expose a per-creator ON-READ rollup VIEW that is
-- the Phase-3 tier-gate interface contract (ruling D3). No stored total, so the
-- meter is deletion-truthful for free.

-- 1) Two capture columns on creator_episodes, written at finalize from the
--    video.asset.ready payload (event.data.duration seconds, event.data
--    .max_stored_resolution). NULLABLE by design: rows created before this
--    column existed — and any created during the prod-first window before the
--    new handler merges — land NULL and are filled by the one-time backfill
--    sweep. duration_seconds is numeric (Mux durations are fractional).
alter table public.creator_episodes
  add column duration_seconds numeric,
  add column max_stored_resolution text;

-- 2) Extend the finalize RPC to write the two columns in the SAME atomic insert
--    (an in-transaction write, never a second non-atomic UPDATE that could fail
--    and leave a null-duration episode that silently under-counts storage).
--
--    Params change the signature, so this is DROP + CREATE, not CREATE OR
--    REPLACE. The two new params DEFAULT NULL so the OLD 3-arg webhook handler
--    (still live until it merges) resolves to THIS function with the extras
--    defaulted — no signature-mismatch break during the prod-first window; those
--    calls just write NULL metrics (backfilled later). Everything else is
--    byte-identical to 20260706120000's body.
--
--    LOAD-BEARING: DROP resets the function ACL to the default PUBLIC EXECUTE,
--    which would re-open the anon-callable hole 20260706150000 closed. The
--    EXECUTE lockdown is therefore RE-APPLIED below on the new signature.
drop function if exists public.mux_finalize_creator_asset_ready(uuid, text, text);
create function public.mux_finalize_creator_asset_ready(
  p_job_id uuid,
  p_asset_id text,
  p_drm_playback_id text,
  p_duration_seconds numeric default null,
  p_max_stored_resolution text default null
) returns text
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_job public.creator_mux_ingest_jobs%rowtype;
  v_episode_number integer;
begin
  select * into v_job
    from public.creator_mux_ingest_jobs
   where id = p_job_id
   for update;
  if not found then
    return 'job_not_found';
  end if;

  if v_job.status = 'ready' then
    return 'already_ready';
  end if;

  if v_job.intended_episode_number is not null then
    v_episode_number := v_job.intended_episode_number;
  else
    select coalesce(max(episode_number), 0) + 1
      into v_episode_number
      from public.creator_episodes
     where creator_title_id = v_job.creator_title_id;
  end if;

  insert into public.creator_episodes (
    creator_title_id, episode_number, label, source,
    mux_playback_id, mux_asset_id, requires_drm, is_published,
    duration_seconds, max_stored_resolution
  ) values (
    v_job.creator_title_id,
    v_episode_number,
    coalesce(v_job.intended_label, 'Episode ' || v_episode_number),
    'mux',
    p_drm_playback_id,
    p_asset_id,
    true,
    false,
    p_duration_seconds,
    p_max_stored_resolution
  );

  update public.creator_mux_ingest_jobs
     set status = 'ready',
         mux_playback_id = p_drm_playback_id
   where id = p_job_id;

  return 'inserted';
end;
$function$;

-- Re-apply the webhook-only EXECUTE lockdown on the NEW signature (DROP wiped it).
revoke all on function public.mux_finalize_creator_asset_ready(uuid, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.mux_finalize_creator_asset_ready(uuid, text, text, numeric, text)
  to service_role;

-- 3) Per-creator rollup VIEW — the Phase-3 tier-gate interface contract (D3).
--    ON-READ SUM over LIVE episodes, no stored total → a deleted episode simply
--    leaves the sum (deletion-truthful with zero decrement bookkeeping). Storage
--    is consumed whether or not an episode is published, so NO is_published
--    filter. Scoped to non-deleted titles to match what /me lists.
--
--    RLS INHERITANCE (note): security_invoker = true makes the view run with the
--    QUERYING role's privileges, so it inherits the deny-all RLS on the
--    underlying creator_* tables (ruling Q1). The service-role client (the meter
--    helper + Phase-3 gate) bypasses RLS and sees all rows; anon/authenticated
--    inherit deny-all and see ZERO rows. Without security_invoker a view runs as
--    its owner and would leak every creator's totals to the Data API.
create view public.creator_storage_usage
  with (security_invoker = true) as
select
  ct.creator_id,
  coalesce(sum(ce.duration_seconds), 0)          as total_duration_seconds,
  coalesce(sum(ce.duration_seconds), 0) / 60.0   as encode_minutes,
  count(ce.id)::int                              as episode_count
from public.creator_titles ct
join public.creator_episodes ce on ce.creator_title_id = ct.id
where ct.deleted_at is null
group by ct.creator_id;

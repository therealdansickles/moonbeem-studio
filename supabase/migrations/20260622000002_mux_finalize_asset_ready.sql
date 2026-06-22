-- Mux U2 (Part 2) — mux_finalize_asset_ready: the ATOMIC video.asset.ready finalize.
--
-- WHY an RPC (not two supabase-js statements): on video.asset.ready with a DRM
-- playback id the webhook must flip the tracking job to 'ready' AND insert the
-- title_episodes row EXACTLY ONCE under Mux's at-least-once delivery. As two
-- separate autocommit statements that is not atomic:
--   * a crash between the committed status flip and the insert leaves a durable
--     'ready' job with no episode, and the retry no-ops on the status gate ->
--     the episode is silently lost; and
--   * a lost post-commit ACK on the insert drives a rollback-and-retry that
--     recomputes a fresh episode_number -> a duplicate published episode (there
--     is no unique on title_episodes.mux_asset_id).
-- One transaction closes both: 'ready' is never durable without its episode, and
-- a redelivery that finds status='ready' is a clean no-op. Mirrors the house
-- pattern (confirm_campaign_funding is the Stripe webhook's atomic transition).
--
-- Returns: 'inserted' (this call created the episode), 'already_ready' (a prior
-- delivery already finalized — no-op), or 'job_not_found'.
--
-- SECURITY DEFINER: writes title_episodes + mux_ingest_jobs (both RLS-gated,
-- service-role only); the webhook calls it with the service-role client.
-- search_path is pinned and every object is schema-qualified.

create or replace function public.mux_finalize_asset_ready(
  p_job_id uuid,
  p_asset_id text,
  p_drm_playback_id text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.mux_ingest_jobs%rowtype;
  v_episode_number integer;
begin
  -- Lock the job row so concurrent deliveries for the same job serialize here.
  select * into v_job
    from public.mux_ingest_jobs
   where id = p_job_id
   for update;
  if not found then
    return 'job_not_found';
  end if;

  -- Idempotent gate: a prior delivery already finalized this asset.
  if v_job.status = 'ready' then
    return 'already_ready';
  end if;

  -- Episode number: the uploader's choice, else MAX+1 for the title (same
  -- server-side numbering as the bulk-add route).
  if v_job.intended_episode_number is not null then
    v_episode_number := v_job.intended_episode_number;
  else
    select coalesce(max(episode_number), 0) + 1
      into v_episode_number
      from public.title_episodes
     where title_id = v_job.title_id;
  end if;

  -- Insert the episode and flip the job in ONE transaction. A constraint
  -- violation here (e.g. a taken episode_number) rolls back the whole call, so
  -- the job stays non-ready and the delivery can be retried. source='mux' +
  -- mux_playback_id NOT NULL + embed_url NULL satisfies title_episodes_source_shape_check.
  insert into public.title_episodes (
    title_id, episode_number, label, source,
    mux_playback_id, mux_asset_id, embed_url,
    requires_drm, is_published, monetization_mode
  ) values (
    v_job.title_id,
    v_episode_number,
    coalesce(v_job.intended_label, 'Episode ' || v_episode_number),
    'mux',
    p_drm_playback_id,
    p_asset_id,
    null,        -- embed_url
    true,        -- requires_drm
    false,       -- is_published: mux episodes land UNPUBLISHED. There is no DRM
                 -- player yet (no MuxPlayer; the Watch tab would render an
                 -- empty/unplayable modal), so the playback unit publishes them
                 -- when a real player exists.
    null         -- monetization_mode (inherits the title default 'free')
  );

  update public.mux_ingest_jobs
     set status = 'ready',
         mux_playback_id = p_drm_playback_id
   where id = p_job_id;

  return 'inserted';
end;
$$;

-- Webhook-only: lock EXECUTE to service_role (the webhook's client). Supabase
-- grants EXECUTE to PUBLIC/anon/authenticated by default on public-schema
-- functions; a SECURITY DEFINER function reachable by anon would let any caller
-- who knows a job_id forge an episode (arbitrary playback id) and bypass the Mux
-- signature + DRM-policy checks. Mirrors confirm_campaign_funding's ACL.
revoke all on function public.mux_finalize_asset_ready(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mux_finalize_asset_ready(uuid, text, text)
  to service_role;

-- pg_cron schedule for the campaign-metering Edge Function.
-- Campaigns v1 (3c.2, Part C).
--
-- Cadence: daily at 03:00 UTC (`0 3 * * *`).
--
-- Why daily — the metering job's natural cadence is ONE campaign
-- per invocation (decision #7), with a 7-day settling window from
-- snapshot to billing (decision #4). A faster cadence buys nothing:
-- within a 24h window, a fan_edit accrues ~1.2 snapshots
-- (REFRESH_INTERVAL_HOURS=20), so daily settling sweeps the day's
-- new mature deltas in one pass. Pro-rata is computed per-run, so
-- once-per-day naturally aligns one pro-rata factor with one
-- current_date — the day-key shape the creator_earnings unique
-- index expects (creator_id, fan_edit_id, calculation_date,
-- campaign_id). With multiple funded campaigns, each takes its
-- turn on subsequent days under FIFO; the Edge Function's
-- pool-positive pre-filter (pickTargetCampaign) lets a younger
-- campaign advance the same day if an older one is drained but
-- not yet 'completed' (3c.3 wires the lifecycle flip).
--
-- 03:00 UTC chosen to land outside the view-tracking pipeline's
-- 10-minute marks (`5,15,25,35,45,55 * * * *`). The two pipelines
-- don't write the same tables, but campaign-metering READS from
-- view_tracking_snapshots — a quiet hour on that read path is
-- hygiene. It also keeps the metering run safely after the prior
-- day's last view-tracking refresh, so the day's snapshots are
-- stable by the time the metering pass reads them.
--
-- Auth: reuses the Vault secret 'service_role_key' that
-- view-tracking and catalog-freshness already use — see Block D /
-- 20260505000009 setup. No vault setup needed in this migration.
-- The token is read at every cron fire via vault.decrypted_secrets,
-- so a key rotation via vault.update_secret takes effect
-- immediately without a migration change.
--
-- HOW TO DISABLE:
--   select cron.unschedule('campaign-metering-daily');
--
-- HOW TO VERIFY IT'S RUNNING:
--   select * from cron.job_run_details
--     where command like '%campaign-metering%'
--     order by start_time desc limit 10;
--   select * from public.campaign_metering_runs
--     order by started_at desc limit 10;
--
-- HOW TO ROTATE THE KEY: same Vault path as view-tracking — see
-- 20260505000009. No migration change required; both schedules
-- read the current decrypted value at every fire.
--
-- DEFENSIVE UNSCHEDULE — this migration adds a `do $$ … perform
-- cron.unschedule(…) … exception when others then null; end $$;`
-- wrapper before the `cron.schedule(…)` call. The view-tracking
-- precedent (20260505000009) does NOT have this wrapper. Reason
-- for the divergence: the MCP-applied migration + history-version
-- correction workflow used for 3c.1 and 3c.2-A makes
-- re-application a realistic operational scenario, and pg_cron's
-- `cron.schedule` is a known footgun — re-calling with the same
-- jobname inserts a SECOND row in `cron.job` under a fresh jobid
-- rather than updating the existing one. That would mean the
-- metering function fires TWICE every day at 03:00 UTC. On a money
-- rail, defense-in-depth is worth diverging from the precedent —
-- the unschedule swallows "not found" so it's a clean no-op on
-- first application, and idempotent on every subsequent
-- application.

-- Defensive presence checks — pg_cron, pg_net, supabase_vault, and
-- the named secret were all confirmed during Block D's rollout
-- (and the view-tracking schedule has been running on them since
-- 20260505000009). If any of them is missing here we want loud
-- failure rather than a silent cron that can't authenticate.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron extension is not enabled';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net extension is not enabled';
  end if;
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception 'supabase_vault extension is not enabled';
  end if;
  if not exists (
    select 1 from vault.secrets where name = 'service_role_key'
  ) then
    raise exception
      'vault secret "service_role_key" not found — Block D rollout setup is missing';
  end if;
end $$;

-- Defensive unschedule (see header rationale). Re-application of
-- this migration must not stack duplicate jobs.
do $$
begin
  perform cron.unschedule('campaign-metering-daily');
exception
  when others then null;
end $$;

select cron.schedule(
  'campaign-metering-daily',
  '0 3 * * *',
  $job$
    select net.http_post(
      url := 'https://qdngcwhubzomwymhaiel.supabase.co/functions/v1/campaign-metering',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'service_role_key'
          limit 1
        ),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $job$
);

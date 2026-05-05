-- pg_cron schedule for the view-tracking Edge Function.
--
-- Cadence: every 10 minutes from :05 to :55 (`5,15,25,35,45,55 * * * *`).
--   Partial chains drain within ~1 hour at current scale (6 fan_edits
--   in 13s); will continue to drain at higher volumes (e.g. 80
--   fan_edits = ~3 minutes per partial run, draining over 6 partial
--   runs ≈ 1 hour). Wood plan headroom: 1500 EnsembleData calls/day;
--   conservative usage at this cadence: 80 calls × ~144 partial runs/
--   day = well under cap because the 20-hour refresh filter means
--   most runs find an empty queue and short-circuit.
--
--   The 5-minute offset (firing at :05/:15/...) avoids overlapping
--   with the catalog-freshness cron (every 10 minutes on the :00 mark
--   — `*/10 * * * *`), so the two pipelines don't race each other for
--   the same Edge Runtime worker on the minute boundary.
--
--   Throughput sanity (verified 2026-05-05): 6 active fan_edits drain
--   in ~13s on a single invocation. At ~2.1s per EnsembleData call,
--   80 fan_edits would need ~168s wall clock — over
--   WALL_CLOCK_BUDGET_MS (25_000). The function exits 'partial' with
--   a cursor at the budget; with 10-min cadence, the next tick
--   continues. With 24h cadence (the alternative considered), a
--   partial would stall a full day before the next chance to drain —
--   unacceptable once Rohan's first CSV import lands ~70+ fan_edits.
--
-- Auth: service_role_key is stored in Supabase Vault (created during
-- the Block D rollout under name 'service_role_key'). This schedule
-- reuses it — no Vault setup required for this migration. The token
-- is read at every cron fire via vault.decrypted_secrets, so a key
-- rotation via vault.update_secret takes effect immediately without
-- a migration change.
--
-- HOW TO DISABLE:
--   select cron.unschedule('view-tracking-every-10min');
--
-- HOW TO VERIFY IT'S RUNNING:
--   select * from cron.job_run_details
--     where command like '%view-tracking%'
--     order by start_time desc limit 10;
--   select * from public.view_tracking_runs
--     order by started_at desc limit 10;
--
-- HOW TO ROTATE THE KEY:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'),
--     '<new key>'
--   );
--   No migration change required — both this schedule and the
--   catalog-freshness schedule read the current decrypted value at
--   every fire.

-- Defensive presence checks — pg_cron, pg_net, supabase_vault, and
-- the named secret were all confirmed during Block D's rollout. If
-- any of them is missing here we want loud failure rather than a
-- silent cron that can't authenticate.
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

select cron.schedule(
  'view-tracking-every-10min',
  '5,15,25,35,45,55 * * * *',
  $job$
    select net.http_post(
      url := 'https://qdngcwhubzomwymhaiel.supabase.co/functions/v1/view-tracking',
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

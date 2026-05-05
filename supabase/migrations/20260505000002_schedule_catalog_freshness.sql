-- pg_cron schedule for the catalog-freshness Edge Function.
--
-- Cadence: every 10 minutes (*/10 * * * *).
--   Throughput math under tuned production caps (400 titles, 5 pages
--   per invocation, set via Edge Function secrets after v1
--   verification): a busy day's ~9000+ titles drains in ~21
--   invocations (verified manually 2026-05-05). At 10-min cadence
--   that's ~3.5 hours from cron-start to drain-complete — well
--   inside one UTC day with margin for partial chains and TMDb
--   slowness.
--   On quiet days or after the chain completes, the function
--   short-circuits in ~110ms via the same-UTC-date alreadyCompleted
--   path; cost of ticking 144x/day after success is ~16s of total
--   CPU — negligible.
--
-- Auth: service_role_key is stored in Supabase Vault and read at
-- cron-fire time via vault.decrypted_secrets. The actual key never
-- appears in this file or in git history.
--
-- ONE-TIME SETUP (run manually in SQL Editor BEFORE applying this migration):
-- select vault.create_secret(
--   '<paste service_role_key from Dashboard → Settings → API>',
--   'service_role_key',
--   'Service role key for catalog-freshness cron http_post'
-- );
--
-- Verify the secret exists:
-- select name, created_at from vault.secrets where name = 'service_role_key';
--
-- HOW TO DISABLE:
--   select cron.unschedule('catalog-freshness-every-10min');
--
-- HOW TO VERIFY IT'S RUNNING:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select * from public.catalog_sync_runs order by started_at desc limit 10;
--
-- HOW TO ROTATE THE KEY:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'),
--     '<new key>'
--   );
--   No migration change required — the schedule reads the current
--   decrypted value at every fire.

-- Defensive presence checks. Extensions are already enabled per the
-- Block D rollout; if they ever get dropped, this migration fails
-- loudly instead of silently scheduling a cron that can't fire.
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
      'vault secret "service_role_key" not found — run the ONE-TIME SETUP at the top of this migration first';
  end if;
end $$;

select cron.schedule(
  'catalog-freshness-every-10min',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url := 'https://qdngcwhubzomwymhaiel.supabase.co/functions/v1/catalog-freshness',
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

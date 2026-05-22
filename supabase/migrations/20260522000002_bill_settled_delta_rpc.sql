-- Campaigns v1 (3c.2, Part A): bill_settled_delta RPC.
--
-- 3c.2 is the metering engine. This RPC is its atomic billing
-- primitive: it turns ONE settled campaign_metering_deltas row into a
-- creator earning plus a campaign-pool debit, in a single
-- transaction. The 3c.2 metering Edge Function (Part B) calls it once
-- per settled, positive-value delta; this RPC is the ONLY path that
-- writes a campaign-tagged creator_earnings row.
--
-- THE THREE WRITES (one transaction — the function body is an
-- implicit transaction; partial application is impossible)
--   1. creator_earnings: INSERT — or accumulate, see below — the
--      earning. campaign_id is ALWAYS set; the row is born payable
--      (withdrawn_at left NULL), so the existing creator withdraw
--      rail picks it up with no changes.
--   2. campaign_ledger: a 'payout' debit — amount_cents NEGATIVE
--      (signed ledger), creator_earning_id FK set. This is what
--      draws the earning down against the campaign's funded pool.
--   3. campaign_metering_deltas: flip the delta to 'billed' and
--      stamp creator_earning_id / prorata_run_id / prorata_factor.
--   All three commit together or not at all.
--
-- IDEMPOTENCY (same-row replay)
--   A delta already at status='billed' returns its existing
--   creator_earning_id and writes nothing. A re-invocation for the
--   same delta — a retried job, a manual re-trigger — is a safe
--   no-op.
--
-- DAY-KEY AGGREGATION (per-snapshot grain meets a day-keyed index)
--   Metering grain is per-snapshot: one delta per (campaign,
--   fan_edit, snapshot). Snapshots land roughly every 20h; the
--   metering job runs every 24h. So roughly every fifth run, two of
--   a fan_edit's deltas for the same campaign settle and bill in the
--   same run — the same UTC current_date. creator_earnings' unique
--   index is day-keyed — (creator_id, fan_edit_id, calculation_date,
--   campaign_id) — so a plain second INSERT would collide.
--   Resolution: ON CONFLICT DO UPDATE. The same-day sibling delta
--   ACCUMULATES its earnings_cents into the existing day-row instead
--   of failing. views_at_calculation is advanced to the later
--   snapshot's count (the more current truth of where the fan_edit
--   is). The earning<->delta relation becomes 1-to-many on those
--   collision days — schema-legal, since
--   campaign_metering_deltas.creator_earning_id is a non-unique FK.
--   The campaign_ledger debit, by contrast, is NOT aggregated — one
--   debit row per delta, always. Even when two deltas share an
--   earnings row, each writes its own signed debit, so the ledger
--   stays a faithful per-delta audit trail and SUM(amount_cents)
--   still equals the true pool balance.
--
-- WITHDRAWN-ROW GUARD (defense against a same-day re-trigger race)
--   The DO UPDATE carries a WHERE clause that requires the existing
--   day-row's withdrawn_at IS NULL. If the day-row has already been
--   withdrawn, the update is silently skipped — RETURNING produces
--   no row, v_earning_id stays NULL, and the RPC raises
--   'earning_already_withdrawn'. The metering delta stays 'settled'
--   (not 'billed'), and no ledger debit is written, so no money
--   moves into a row that won't pay out.
--   In the designed flow this cannot happen: the daily cron bills
--   all of a campaign's settled deltas in one back-to-back batch
--   within a single invocation, and different runs land on
--   different current_date values so cross-run siblings never
--   ON CONFLICT at all. The guard is a defense against an
--   operationally-possible-but-not-designed-for race: a manual
--   same-day re-trigger of the job after a creator has withdrawn
--   between triggers. Raise loudly so the operator sees it.
--
-- views_at_calculation
--   Sourced from the delta's OWN snapshot
--   (view_tracking_snapshots.view_count joined on md.snapshot_id) —
--   the exact view count at the moment the delta appeared, not the
--   drifted current fan_edits.view_count. Billing happens at least 7
--   days after the snapshot; the denormalized value has long moved
--   on.
--
-- claimed (mirrors legacy is_stub-derived value)
--   Looked up from creators.is_stub for p_creator_id at billing
--   time. claimed = NOT coalesce(is_stub, false) — a real creator
--   gets claimed=true, a stub creator gets claimed=false, and a
--   NULL is_stub (legacy data) is treated as a real creator,
--   matching legacy earnings-calc.ts's `!!c.is_stub` coercion. A
--   creator row that does not exist raises 'unknown_creator' —
--   stricter than legacy's silent default-to-stub. The Edge
--   Function should never call the RPC with a creator_id that
--   isn't a live creators row, so this is a defensive guard.
--   On the DO UPDATE path, claimed is NOT in the SET list — the
--   existing day-row keeps its claimed value. All deltas for the
--   same fan_edit share a creator, so the value is the same; the
--   omission preserves the first-write value cleanly.
--
-- prorata_yields_zero
--   floor(full_cpm_cents * prorata_factor) <= 0 raises this. It is a
--   DEFENSIVE BACKSTOP, not a normal path: Part B's Pass 2 filters
--   full_cpm_cents > 0 before calling the RPC, so baseline /
--   zero-view deltas never reach it. If this exception ever fires,
--   the caller billed a row it should have skipped.
--
-- ATTRIBUTION / PRICING are the caller's job
--   The RPC bills exactly the delta it is handed, at exactly the
--   prorata_factor it is handed. FIFO campaign attribution, campaign
--   eligibility, the campaign CPM that produced full_cpm_cents, and
--   the per-run pro-rata factor are all decided by the Edge
--   Function. The RPC's only campaign-state guard is a sanity check
--   that the campaign is still 'funded' / 'live' — a caller billing
--   a 'paused' or 'completed' campaign is wrong.
--
-- Caller: the metering Edge Function, using the service-role key.
-- Grants are service_role only — the same Stage-1.5 lockdown
-- discipline as confirm_campaign_funding (20260519000003).
-- Conventions follow confirm_campaign_funding: language plpgsql,
-- security definer, set search_path = public, p_-prefixed args,
-- snake_case raised exceptions, SELECT ... FOR UPDATE locking.
--
-- partner_credits is NOT touched here. campaigns.status is NOT
-- touched here. Those lifecycle transitions are 3c.3.

create or replace function public.bill_settled_delta(
  p_metering_delta_id uuid,
  p_prorata_run_id uuid,
  p_prorata_factor numeric,
  p_creator_id uuid,
  p_partner_id uuid,
  p_title_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_md_status text;
  v_md_full_cpm integer;
  v_md_campaign_id uuid;
  v_md_fan_edit_id uuid;
  v_md_snapshot_id uuid;
  v_md_existing_earning uuid;
  v_campaign_status text;
  v_is_stub boolean;
  v_billed_cents integer;
  v_views integer;
  v_earning_id uuid;
begin
  -- Lock the metering delta and its campaign in one statement.
  select md.status, md.full_cpm_cents, md.campaign_id,
         md.fan_edit_id, md.snapshot_id, md.creator_earning_id,
         c.status
    into v_md_status, v_md_full_cpm, v_md_campaign_id,
         v_md_fan_edit_id, v_md_snapshot_id, v_md_existing_earning,
         v_campaign_status
    from public.campaign_metering_deltas md
    join public.campaigns c on c.id = md.campaign_id
    where md.id = p_metering_delta_id
    for update of md, c;

  if not found then
    raise exception 'unknown_metering_delta';
  end if;

  -- Idempotent same-row replay: this delta is already billed.
  if v_md_status = 'billed' then
    return v_md_existing_earning;
  end if;

  if v_md_status <> 'settled' then
    raise exception 'invalid_metering_delta_state';
  end if;

  if v_campaign_status not in ('funded', 'live') then
    raise exception 'invalid_campaign_state';
  end if;

  if p_prorata_factor is null or
     p_prorata_factor <= 0 or
     p_prorata_factor > 1 then
    raise exception 'invalid_prorata_factor';
  end if;

  v_billed_cents := floor(v_md_full_cpm * p_prorata_factor);
  if v_billed_cents <= 0 then
    raise exception 'prorata_yields_zero';
  end if;

  -- Source views_at_calculation from the actual snapshot this
  -- delta represents — the precise view count at the moment the
  -- delta appeared, not the current denormalized
  -- fan_edits.view_count.
  select view_count
    into v_views
    from public.view_tracking_snapshots
    where id = v_md_snapshot_id;

  if v_views is null then
    raise exception 'unknown_snapshot';
  end if;

  -- Look up creator stub status for `claimed` (mirrors legacy
  -- earnings-calc.ts semantics: claimed=true for real creators,
  -- false for stubs; legacy treats NULL is_stub as real via the
  -- `!!c.is_stub` coercion, mirrored here by coalesce(..., false)).
  -- Missing creator row is a defensive error — the Edge Function
  -- should never call with a stranger creator_id.
  select is_stub
    into v_is_stub
    from public.creators
    where id = p_creator_id;

  if not found then
    raise exception 'unknown_creator';
  end if;

  -- INSERT-or-accumulate on the day-keyed unique index. Two
  -- metering deltas on the same UTC day for the same
  -- (creator, fan_edit, campaign) aggregate into one earnings row.
  -- Each delta's earning is summed in; each delta still writes its
  -- own campaign_ledger debit and stamps its own creator_earning_id
  -- back. The earning<->delta relation is 1-to-many on collision
  -- days; this is schema-legal (the FK on
  -- campaign_metering_deltas.creator_earning_id is not unique). On
  -- collision, views_at_calculation is updated to the more recent
  -- snapshot's view count (the later delta's snapshot is the more
  -- current truth of "where we are today").
  --
  -- The DO UPDATE WHERE guards against a manual same-day re-trigger
  -- after a creator has withdrawn the day-row: if withdrawn_at is
  -- already set, the update is silently skipped, RETURNING produces
  -- no row, v_earning_id stays NULL, and we raise
  -- 'earning_already_withdrawn' below. No money moves into a row
  -- that won't pay out.
  insert into public.creator_earnings (
    creator_id, fan_edit_id, partner_id, title_id,
    views_at_calculation, earnings_cents,
    calculation_date, campaign_id, claimed
  ) values (
    p_creator_id, v_md_fan_edit_id, p_partner_id, p_title_id,
    v_views, v_billed_cents,
    current_date, v_md_campaign_id, not coalesce(v_is_stub, false)
  )
  on conflict (creator_id, fan_edit_id, calculation_date,
               campaign_id)
  do update set
    earnings_cents = public.creator_earnings.earnings_cents
                     + excluded.earnings_cents,
    views_at_calculation = excluded.views_at_calculation
  where public.creator_earnings.withdrawn_at is null
  returning id into v_earning_id;

  if v_earning_id is null then
    raise exception 'earning_already_withdrawn';
  end if;

  -- Per-delta ledger debit. NOT aggregated — the ledger records one
  -- debit per delta even when earnings rows aggregate, so per-delta
  -- auditability is preserved.
  insert into public.campaign_ledger (
    campaign_id, entry_type, amount_cents,
    creator_earning_id, campaign_funding_id, note
  ) values (
    v_md_campaign_id, 'payout', -v_billed_cents,
    v_earning_id, null, null
  );

  -- Flip the metering delta to billed and stamp its links.
  update public.campaign_metering_deltas
    set status = 'billed',
        creator_earning_id = v_earning_id,
        prorata_run_id = p_prorata_run_id,
        prorata_factor = p_prorata_factor,
        updated_at = now()
    where id = p_metering_delta_id;

  return v_earning_id;
end;
$$;

revoke execute on function public.bill_settled_delta(
  uuid, uuid, numeric, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.bill_settled_delta(
  uuid, uuid, numeric, uuid, uuid, uuid
) to service_role;

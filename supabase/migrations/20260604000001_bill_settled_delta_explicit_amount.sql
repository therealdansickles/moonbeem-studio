-- Money-rail fix, commit (i): bill_settled_delta takes an explicit
-- p_billed_cents amount instead of recomputing floor(full_cpm × factor).
--
-- WHY
--   The 3c.2 metering job billed each delta at floor(full_cpm ×
--   prorata_factor). floor() systematically under-bills, leaving a
--   sub-cent-per-row residue that accumulated and wedged the pool a few
--   cents above zero — making the strict-zero completion condition
--   (campaign-metering applyLifecycleTransitions, pool === 0)
--   unreachable. Campaign e8150462 froze at 1¢ with 523 settled deltas.
--
--   The fix moves the apportionment up into the Edge Function, which now
--   computes an integer largest-remainder (Hamilton) distribution of the
--   pool across the settled set so Σ billed === pool EXACTLY, and passes
--   each delta's authoritative amount here. This RPC no longer derives
--   the money from the factor; it bills exactly what it is handed.
--
-- WHAT CHANGES (the ONLY behavioral change)
--   - New parameter p_billed_cents integer — the authoritative amount.
--   - v_billed_cents is now p_billed_cents, not floor(v_md_full_cpm ×
--     p_prorata_factor). The internal recompute is removed.
--   - p_prorata_factor is RETAINED but used ONLY to stamp the delta's
--     prorata_factor (audit), never for money.
--
-- WHAT IS PRESERVED EXACTLY (every other behavior — line-for-line)
--   - the SELECT … FOR UPDATE OF md, c lock
--   - idempotent already-'billed' replay (returns existing earning)
--   - the v_md_status / v_campaign_status / p_prorata_factor guards and
--     every RAISE path (unknown_metering_delta, invalid_metering_delta_
--     state, invalid_campaign_state, invalid_prorata_factor,
--     prorata_yields_zero, unknown_snapshot, unknown_creator,
--     earning_already_withdrawn)
--   - views_at_calculation sourced from the delta's own snapshot
--   - the day-keyed ON CONFLICT (creator_id, fan_edit_id,
--     calculation_date, campaign_id) accumulation:
--     earnings_cents = earnings_cents + excluded.earnings_cents, with the
--     withdrawn_at IS NULL guard
--   - exactly one campaign_ledger 'payout' debit per delta,
--     amount_cents = -v_billed_cents, creator_earning_id FK set
--   - the delta flip to 'billed' + prorata_run_id / prorata_factor stamps
--   - the service-role-only lockdown (REVOKE … FROM public, anon,
--     authenticated; GRANT EXECUTE TO service_role)
--
-- SIGNATURE CHANGE ⇒ DROP then CREATE
--   Adding a parameter changes the function signature; CREATE OR REPLACE
--   would leave the old 6-arg overload in place alongside the new 7-arg
--   one (two callable functions). DROP the old signature first so only
--   the new one exists. The DROP is signature-qualified to the OLD
--   6-arg form.

-- ---------------------------------------------------------------
-- 1. Drop the old 6-arg signature.
-- ---------------------------------------------------------------
drop function if exists public.bill_settled_delta(
  uuid, uuid, numeric, uuid, uuid, uuid
);

-- ---------------------------------------------------------------
-- 2. The RPC, with p_billed_cents.
-- ---------------------------------------------------------------

create or replace function public.bill_settled_delta(
  p_metering_delta_id uuid,
  p_prorata_run_id uuid,
  p_prorata_factor numeric,
  p_billed_cents integer,
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

  -- The caller (Edge Function Pass 1) supplies the authoritative
  -- amount via largest-remainder apportionment. We no longer recompute
  -- from the factor. The positivity guard is retained (same
  -- 'prorata_yields_zero' contract): the caller skips deltas whose
  -- apportioned amount is 0, so reaching here with <= 0 is a caller
  -- bug, raised loudly rather than billed.
  v_billed_cents := p_billed_cents;
  if v_billed_cents is null or v_billed_cents <= 0 then
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
  uuid, uuid, numeric, integer, uuid, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.bill_settled_delta(
  uuid, uuid, numeric, integer, uuid, uuid, uuid
) to service_role;

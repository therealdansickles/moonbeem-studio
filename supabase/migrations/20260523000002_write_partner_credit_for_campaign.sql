-- Campaigns v1 (3c.3, Part A): write_partner_credit_for_campaign RPC.
--
-- PURPOSE
--   The rollover primitive. Turns a campaign's leftover pool into a
--   partner_credits row the partner can apply to a future campaign,
--   drains the campaign's pool to zero in the same transaction, and
--   flips the campaign to 'completed'.
--
--   Built but NOT called from the 3c.3 metering job. The metering
--   job's own completion path triggers at strict pool == 0 (decision
--   #2), which has nothing to roll over by definition. This RPC is
--   reserved for future admin-UI manual-completion flows — when a
--   partner ends a campaign early with a positive remaining pool.
--
-- THE THREE WRITES (one transaction)
--   1. partner_credits: INSERT a new row at full availability —
--      remaining_cents equals amount_cents, status defaults to
--      'available', applied_to_campaign_id is NULL.
--   2. campaign_ledger: a 'rollover_debit' entry with
--      amount_cents = -leftover_pool. SUM(campaign_ledger.amount_cents)
--      after this insert is exactly 0, so the campaign's pool is
--      drained — the money is now in the partner_credits row, not in
--      this campaign.
--   3. campaigns: status -> 'completed', completed_at -> now().
--   All three commit together or not at all (function body is an
--   implicit transaction).
--
-- ROLLOVER SEMANTICS
--   Pool money becomes an available partner credit. The credit can
--   be applied to a future campaign by setting applied_to_campaign_id
--   and decrementing remaining_cents (outside this RPC's scope —
--   that's the future credit-application path). The 'rollover_debit'
--   ledger entry preserves auditability: the campaign's full
--   per-row history — funding credit, every payout debit, and this
--   single rollover debit — still SUMs to the true pool balance at
--   any point in time, and the rollover entry is greppable.
--
-- RAISE PATHS
--   - unknown_campaign:        p_campaign_id has no row.
--   - invalid_campaign_state:  status is not 'live' or 'funded'.
--                              An already-'completed' campaign would
--                              double-roll; 'draft' has no pool;
--                              'paused' should not be rolled over
--                              by this path (a separate ops decision
--                              if needed).
--   - no_pool_to_roll_over:    COALESCE(SUM(amount_cents), 0) <= 0.
--                              A drained or empty-ledger campaign has
--                              nothing to credit; the caller should
--                              transition to 'completed' through a
--                              different path (the metering job's own
--                              completion handles strict zero).
--
-- ROLLOVER-DURING-METERING RACE
--   If this RPC is called while the metering job is mid-run on the
--   same campaign (between two bill_settled_delta calls), serialization
--   is correct:
--     1. The rollover's SELECT ... FOR UPDATE on the campaign row
--        blocks behind the metering job's in-flight RPC (which also
--        FOR UPDATE-locks the campaign row in bill_settled_delta).
--     2. The current bill_settled_delta commits — its earning + debit
--        are recorded.
--     3. The rollover acquires the campaign lock, recomputes
--        leftover_pool from the now-current ledger (including that
--        just-committed debit), inserts the partner_credits row,
--        writes the rollover_debit drain, and flips status to
--        'completed'. Lock released.
--     4. The metering run resumes its iteration. Subsequent
--        bill_settled_delta calls for remaining 'settled' rows on
--        this campaign find status='completed' and raise
--        'invalid_campaign_state'. Those errors are caught by the
--        metering function's per-row catch (rpc_errors entry) and the
--        run continues to next deltas — but since one campaign per
--        invocation, there are no next campaigns this tick.
--
--   This is correct behavior — the admin's manual rollover wins over
--   in-flight billing on the same campaign. The metering run
--   degrades gracefully (per-row failures, not a run-level abort).
--   Any 'settled' rows for the rolled-over campaign that didn't get
--   billed before the rollover will keep failing on future runs
--   (status='completed' is permanent and the metering job's
--   pickTargetCampaign filter excludes 'completed' campaigns, so
--   they won't even be picked again — but if a row stays 'settled'
--   it accrues no money and contaminates no math). 3c.4's
--   verification or a future ops cleanup tool can void those
--   orphaned 'settled' rows. The rollover itself deliberately does
--   NOT touch campaign_metering_deltas — the metering table is the
--   metering job's domain.
--
-- LOCKDOWN
--   Service-role only — signature-qualified REVOKE / GRANT, same
--   Stage-1.5 discipline as confirm_campaign_funding (20260519000003)
--   and bill_settled_delta (20260522000002). Future admin-UI calls
--   route through a server route using createServiceRoleClient().
--
-- CONVENTIONS — language plpgsql, security definer, set search_path
-- = public, p_-prefixed args, snake_case raised exceptions, SELECT
-- ... FOR UPDATE locking on the campaign row only (the ledger
-- INSERT is append-only and the partner_credits INSERT is fresh, so
-- neither needs explicit locking; the campaign lock alone serializes
-- against bill_settled_delta and against concurrent rollover calls).

-- ---------------------------------------------------------------
-- 1. Extend campaign_ledger_entry_type_check to allow 'rollover_debit'.
-- ---------------------------------------------------------------
-- DROP-then-ADD, matching the campaigns family's pattern for
-- evolving CHECK constraints (see campaigns_v1_schema's status
-- checks and 20260519000004's campaign_funding_status_check
-- supersede extension). 'rollover_debit' is added alongside the
-- existing four values; no existing rows change.

alter table public.campaign_ledger
  drop constraint if exists campaign_ledger_entry_type_check;

alter table public.campaign_ledger
  add constraint campaign_ledger_entry_type_check
  check (entry_type in (
    'funding', 'payout', 'refund', 'adjustment', 'rollover_debit'
  ));

-- ---------------------------------------------------------------
-- 2. The RPC.
-- ---------------------------------------------------------------

create or replace function public.write_partner_credit_for_campaign(
  p_campaign_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_partner_id uuid;
  v_campaign_status text;
  v_leftover_pool integer;
  v_credit_id uuid;
begin
  -- Lock the campaign row. This serializes against concurrent
  -- bill_settled_delta calls (which also FOR UPDATE-lock the
  -- campaign) and against concurrent rollover attempts.
  select partner_id, status
    into v_partner_id, v_campaign_status
    from public.campaigns
    where id = p_campaign_id
    for update;

  if not found then
    raise exception 'unknown_campaign';
  end if;

  -- Only campaigns that haven't yet been completed can roll over.
  -- 'completed' would double-roll; 'draft' has no pool; 'paused'
  -- isn't this path's responsibility.
  if v_campaign_status not in ('live', 'funded') then
    raise exception 'invalid_campaign_state';
  end if;

  -- Authoritative leftover_pool. Computed AFTER the lock so any
  -- concurrent bill_settled_delta that committed just before us is
  -- already reflected in the ledger SUM.
  select coalesce(sum(amount_cents), 0)
    into v_leftover_pool
    from public.campaign_ledger
    where campaign_id = p_campaign_id;

  if v_leftover_pool <= 0 then
    raise exception 'no_pool_to_roll_over';
  end if;

  -- Write the credit at full availability. remaining_cents equals
  -- amount_cents on creation; status takes its 'available' default;
  -- applied_to_campaign_id is explicitly NULL (the credit is not
  -- yet applied to any campaign).
  insert into public.partner_credits (
    partner_id,
    source_campaign_id,
    applied_to_campaign_id,
    amount_cents,
    remaining_cents
  ) values (
    v_partner_id,
    p_campaign_id,
    null,
    v_leftover_pool,
    v_leftover_pool
  )
  returning id into v_credit_id;

  -- Drain the campaign's pool. After this insert,
  -- SUM(amount_cents) over campaign_ledger for this campaign is
  -- exactly 0 — the rollover_debit cancels every prior credit.
  -- creator_earning_id and campaign_funding_id are NULL — this
  -- entry references the partner_credits row instead, via the note
  -- (no FK column for it in v1).
  insert into public.campaign_ledger (
    campaign_id,
    entry_type,
    amount_cents,
    creator_earning_id,
    campaign_funding_id,
    note
  ) values (
    p_campaign_id,
    'rollover_debit',
    -v_leftover_pool,
    null,
    null,
    'Rollover to partner_credits ' || v_credit_id
  );

  -- Flip status to completed. Belt-and-braces UPDATE — the WHERE
  -- redundantly guards against a state change between our lock and
  -- this UPDATE (impossible since we hold the row lock, but
  -- matches confirm_campaign_funding's defensive style). updated_at
  -- is also set explicitly even though set_updated_at_campaigns
  -- would set it; same belt-and-braces consistency.
  update public.campaigns
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where id = p_campaign_id
      and status in ('live', 'funded');

  return v_credit_id;
end;
$$;

revoke execute on function public.write_partner_credit_for_campaign(
  uuid
) from public, anon, authenticated;

grant execute on function public.write_partner_credit_for_campaign(
  uuid
) to service_role;

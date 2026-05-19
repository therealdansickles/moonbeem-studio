-- Campaigns v1 (3b, Stage 3 Part C): teach confirm_campaign_funding
-- to detect a double-fund and mark the second row 'superseded'
-- instead of double-crediting the ledger.
--
-- Background: the previous version of the RPC
-- (20260519000002_campaigns_funding_rpc.sql) allowed
-- campaign.status='funded' to pass through to the credit + status
-- writes. That was intended for genuine same-row replay (a Stripe
-- webhook delivered twice for the same campaign_funding id), and the
-- early-return on cf.status='succeeded' handles that case. But it
-- also let a DIFFERENT pending campaign_funding row credit the
-- ledger AGAIN if a campaign was already funded by an earlier row —
-- the double-fund scenario.
--
-- Scenario: a partner opens Fund in two browser tabs, two pending
-- campaign_funding rows exist with two Checkout sessions, both end
-- up paid. Two checkout.session.completed webhooks fire. The first
-- one credits cleanly. The second one — with the OLD RPC — would
-- also credit, double-funding the pool against a single partner
-- charge per session (i.e. the partner paid twice, pool is credited
-- twice, that's the actual money-correctness bug).
--
-- Stage 3 Part B adds an application-layer guard on the fund
-- endpoint that blocks creating a second concurrent pending row.
-- This RPC change is the database-layer backstop: even if the
-- application-layer guard is somehow bypassed, the RPC will not
-- write a second ledger credit. Belt and suspenders.
--
-- The new logic:
--   - cf.status='succeeded' -> no-op return (same-row replay; unchanged)
--   - cf.status='failed'    -> raise 'already_failed' (unchanged)
--   - cf.status='superseded'-> no-op return (idempotent replay on a
--                              row we already marked as superseded)
--   - cf.status='pending' AND campaign.status='funded' ->
--       this is the double-fund. UPDATE this funding row to
--       'superseded' and return WITHOUT writing a ledger row and
--       WITHOUT touching the campaign. The webhook handler treats
--       this as an ack-200 success.
--   - cf.status='pending' AND campaign.status='draft' ->
--       normal flow: cf->succeeded, ledger credit, campaign->funded.
--   - otherwise -> raise 'invalid_funding_state' / 'invalid_campaign_state'.
--
-- A 'superseded' funding row represents a partner payment that did
-- NOT credit the pool. The partner is owed a refund for that
-- session. Refund processing is a follow-up, not in 3b's scope —
-- 3b's job is (a) prevent the double-credit and (b) make the
-- superseded row clearly visible for ops.
--
-- Migration touches:
--   1. campaign_funding_status_check CHECK constraint: drop + re-add
--      to include 'superseded'.
--   2. CREATE OR REPLACE FUNCTION confirm_campaign_funding(uuid)
--      — same signature (returns uuid), body-only change. Per the
--      project memory on Postgres function return-type changes,
--      same-signature replacement is safe.
--   3. Grants are unchanged (the prior migrations set them to
--      service_role only); CREATE OR REPLACE preserves grants.

-- ---------------------------------------------------------------
-- 1. Extend the status CHECK to allow 'superseded'.
-- ---------------------------------------------------------------

alter table public.campaign_funding
  drop constraint if exists campaign_funding_status_check;

alter table public.campaign_funding
  add constraint campaign_funding_status_check
  check (status in ('pending', 'succeeded', 'failed', 'superseded'));

-- ---------------------------------------------------------------
-- 2. CREATE OR REPLACE the RPC body. Same signature.
-- ---------------------------------------------------------------

create or replace function public.confirm_campaign_funding(
  p_campaign_funding_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cf_id uuid;
  v_cf_status text;
  v_cf_amount_cents integer;
  v_campaign_id uuid;
  v_campaign_status text;
begin
  -- Lock both rows in one statement. Blocks concurrent webhook
  -- deliveries for the same funding row until this transaction
  -- commits.
  select cf.id, cf.status, cf.amount_cents, cf.campaign_id, c.status
    into v_cf_id, v_cf_status, v_cf_amount_cents, v_campaign_id, v_campaign_status
    from public.campaign_funding cf
    join public.campaigns c on c.id = cf.campaign_id
    where cf.id = p_campaign_funding_id
    for update of cf, c;

  if not found then
    raise exception 'unknown_funding';
  end if;

  -- Idempotent early returns. A redelivered webhook for an already-
  -- terminal funding row lands here. Both 'succeeded' and the new
  -- 'superseded' are terminal-success states from the webhook
  -- handler's perspective (no further work to do, ack 200).
  if v_cf_status = 'succeeded' or v_cf_status = 'superseded' then
    return v_campaign_id;
  end if;

  if v_cf_status = 'failed' then
    raise exception 'already_failed';
  end if;

  if v_cf_status <> 'pending' then
    raise exception 'invalid_funding_state';
  end if;

  -- Double-fund detection. A pending funding row whose campaign is
  -- already 'funded' means a DIFFERENT campaign_funding row beat
  -- this one to the credit. Mark this row 'superseded' and return
  -- WITHOUT writing a ledger row. The partner paid for this
  -- session; refund is a follow-up.
  if v_campaign_status = 'funded' then
    update public.campaign_funding
      set status = 'superseded',
          updated_at = now()
      where id = v_cf_id;
    return v_campaign_id;
  end if;

  -- Any other non-draft campaign state is unexpected — paused /
  -- completed campaigns shouldn't have pending funding rows.
  if v_campaign_status <> 'draft' then
    raise exception 'invalid_campaign_state';
  end if;

  -- Normal flow: campaign is 'draft', funding row is 'pending'.
  update public.campaign_funding
    set status = 'succeeded',
        updated_at = now()
    where id = v_cf_id;

  -- Ledger credit: the POOL only. fee_cents stays on the
  -- campaign_funding row as Moonbeem revenue; it does not enter
  -- the spendable pool.
  insert into public.campaign_ledger (
    campaign_id,
    entry_type,
    amount_cents,
    campaign_funding_id
  ) values (
    v_campaign_id,
    'funding',
    v_cf_amount_cents,
    v_cf_id
  );

  -- Guarded UPDATE: only flips draft -> funded. Belt-and-braces
  -- (the campaign_status check above already gates this, but the
  -- WHERE clause is a second line of defense).
  update public.campaigns
    set status = 'funded',
        funded_at = now(),
        updated_at = now()
    where id = v_campaign_id
      and status = 'draft';

  return v_campaign_id;
end;
$$;

-- CREATE OR REPLACE preserves existing grants — the
-- service_role-only lockdown from 20260519000003 remains in effect.
-- No additional grant statements needed.

-- Campaigns v1 (3b): funding-confirmation RPC.
--
-- Called from the Stripe webhook handler after a checkout session
-- completes. Atomically:
--   1. Flips campaign_funding.status pending -> succeeded.
--   2. Inserts a campaign_ledger row (entry_type='funding') for the
--      pool amount only — NOT pool+fee. The 10% Moonbeem fee is
--      Moonbeem revenue and never enters the spendable pool.
--   3. Flips campaigns.status draft -> funded and stamps funded_at.
--
-- All three writes happen in a single PL/pgSQL transaction (function
-- body = implicit transaction). Partial application is impossible.
--
-- Idempotency: the webhook handler may deliver the same event more
-- than once (Stripe retries on 2xx-not-yet-received, and the operator
-- can manually re-send from the Stripe dashboard). Idempotency comes
-- from a SELECT ... FOR UPDATE on the funding row + a status check:
--   - status='succeeded' already      -> no-op, return success
--   - status='failed'                 -> raise 'already_failed'
--   - status='pending'                -> proceed
--   - any other value                 -> raise 'invalid_funding_state'
-- The same lock covers the joined campaigns row so a concurrent
-- second delivery serializes behind the first.
--
-- Identification: the RPC takes p_campaign_funding_id (the local
-- row id). The webhook handler retrieves this from the Stripe event
-- metadata round-trip rather than looking up by
-- stripe_payment_intent_id — the metadata path is the source of
-- truth at create-time and is cleaner under retry.
--
-- Caller: the webhook handler uses createServiceRoleClient(), so
-- this function is granted to service_role only. Precedent:
-- find_title_duplicates (20260515000003) and find_or_create_stub_creator
-- (20260506000007). Pattern otherwise follows
-- mark_social_verified_and_merge (20260508000004) — language plpgsql,
-- security definer, set search_path = public, p_-prefixed args,
-- snake_case raised exceptions, SELECT ... FOR UPDATE for locking.

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
  -- Lock both rows in one statement. `FOR UPDATE OF cf, c` blocks
  -- any concurrent webhook delivery for the same funding row until
  -- this transaction commits.
  select cf.id, cf.status, cf.amount_cents, cf.campaign_id, c.status
    into v_cf_id, v_cf_status, v_cf_amount_cents, v_campaign_id, v_campaign_status
    from public.campaign_funding cf
    join public.campaigns c on c.id = cf.campaign_id
    where cf.id = p_campaign_funding_id
    for update of cf, c;

  if not found then
    raise exception 'unknown_funding';
  end if;

  -- Idempotent early return: a redelivered webhook for an already-
  -- confirmed funding row lands here.
  if v_cf_status = 'succeeded' then
    return v_campaign_id;
  end if;

  if v_cf_status = 'failed' then
    raise exception 'already_failed';
  end if;

  if v_cf_status <> 'pending' then
    raise exception 'invalid_funding_state';
  end if;

  -- Allow 'funded' so a retry where the funding row is stuck at
  -- 'pending' but the campaign was somehow already advanced still
  -- converges cleanly. Disallow any other state.
  if v_campaign_status not in ('draft', 'funded') then
    raise exception 'invalid_campaign_state';
  end if;

  update public.campaign_funding
    set status = 'succeeded',
        updated_at = now()
    where id = v_cf_id;

  -- Ledger credit: the POOL only. fee_cents stays on the
  -- campaign_funding row as Moonbeem revenue; it does not enter the
  -- spendable pool. amount_cents is positive (signed ledger;
  -- payouts/refunds will be negative entries).
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

  -- Guarded UPDATE: only flips draft -> funded. If the campaign is
  -- already 'funded' (manual replay scenario), this is a no-op and
  -- funded_at is preserved from the original transition.
  update public.campaigns
    set status = 'funded',
        funded_at = now(),
        updated_at = now()
    where id = v_campaign_id
      and status = 'draft';

  return v_campaign_id;
end;
$$;

revoke execute on function public.confirm_campaign_funding(uuid) from public;
grant execute on function public.confirm_campaign_funding(uuid) to service_role;

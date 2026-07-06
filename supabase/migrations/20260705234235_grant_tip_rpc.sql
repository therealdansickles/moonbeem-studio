-- Applied to prod via apply_migration (recorded version 20260705234235); prefix
-- aligned so `db push` will not re-run it.
--
-- grant_tip — atomic tip settle at checkout.session.completed. Marks the pending
-- tip paid (records PI / session / receipt / absorbed fee) and writes ONE
-- transaction_settlements row that IS the creator's payout: gross = affiliate_cut
-- (creator owed 100%), stripe_fee = moonbeem_take = distributor_net = 0 (Moonbeem
-- absorbs the Stripe fee). Sum invariant holds: 0+0+0+amount = amount. Idempotent
-- via FOR UPDATE + the pending-status guard (+ ON CONFLICT backstop). Mirrors
-- grant_entitlement / confirm_campaign_funding.
create or replace function public.grant_tip(
  p_tip_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_receipt_url text,
  p_stripe_fee_absorbed_cents integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tip record;
begin
  select id, creator_id, amount_cents, status
    into v_tip
    from public.tips
    where id = p_tip_id
    for update;

  if not found then
    return 'unknown_tip';
  end if;

  -- Idempotent: a redelivered webhook lands here once the tip is terminal.
  if v_tip.status <> 'pending' then
    return 'already_granted';
  end if;

  update public.tips
    set status = 'paid',
        stripe_payment_intent_id = p_payment_intent_id,
        stripe_checkout_session_id = p_session_id,
        receipt_url = p_receipt_url,
        stripe_fee_absorbed_cents = p_stripe_fee_absorbed_cents,
        paid_at = now()
    where id = p_tip_id;

  insert into public.transaction_settlements (
    tip_id, entitlement_id, title_id, partner_id, creator_id,
    gross_cents, post_fee_cents, stripe_fee_cents, moonbeem_take_cents,
    distributor_net_cents, affiliate_cut_cents, moonbeem_take_bps, creator_share_bps,
    payout_status
  ) values (
    p_tip_id, null, null, null, v_tip.creator_id,
    v_tip.amount_cents, v_tip.amount_cents, 0, 0,
    0, v_tip.amount_cents, 0, 10000,
    'held'
  )
  on conflict (tip_id) where tip_id is not null do nothing;

  return 'granted';
end;
$$;

-- Transactions sub-unit 4 — generalized entitlement grant (rental OR purchase).
-- IDENTICAL to grant_rental_entitlement except the kind is the p_kind parameter
-- (validated against the entitlements.kind CHECK values) instead of the 'rental'
-- literal. Same idempotency (ON CONFLICT on the Stripe session id), same
-- 'granted'/'already_granted' return. The webhook moves to this for both kinds.
--
-- grant_rental_entitlement is intentionally NOT dropped here — it stays alongside
-- so prod never references a missing function during the deploy window. It is
-- removed in a later cleanup, AFTER prod confirms grant_entitlement handles real
-- rentals.
create or replace function public.grant_entitlement(
  p_session_id text,
  p_user_id uuid,
  p_title_id uuid,
  p_kind text,
  p_price_cents integer,
  p_payment_intent_id text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Defense against a bad metadata value granting a garbage kind. Mirrors the
  -- entitlements.kind CHECK; raising here (not silently inserting) makes a poisoned
  -- event fail loudly rather than write an unusable row.
  if p_kind not in ('rental', 'purchase') then
    raise exception 'invalid entitlement kind: %', p_kind;
  end if;

  insert into public.entitlements (
    user_id, title_id, kind, price_paid_cents,
    stripe_checkout_session_id, stripe_payment_intent_id
  ) values (
    p_user_id, p_title_id, p_kind, p_price_cents,
    p_session_id, p_payment_intent_id
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is null then
    return 'already_granted';
  end if;
  return 'granted';
end;
$$;

-- LOCKDOWN (same as grant_rental_entitlement / stamp_first_play: Supabase default
-- privileges re-grant EXECUTE to anon+authenticated on every new public.* function
-- — revoke from all three, then grant only to service_role).
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text) from public;
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text) from anon;
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text) from authenticated;
grant execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text) to service_role;

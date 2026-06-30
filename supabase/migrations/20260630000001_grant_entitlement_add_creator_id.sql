-- Affiliate attribution Stage 1 — add creator_id to the entitlement grant path.
--
-- SUPERSEDES 20260626000003_grant_entitlement_generalized.sql. Adds a trailing,
-- defaulted p_creator_id uuid arg whose value is written to entitlements.creator_id.
-- INERT until a caller passes a non-null p_creator_id (Stage 3, once checkout
-- metadata carries moonbeem_creator_id): every grant today writes creator_id = NULL,
-- exactly the pre-Stage-1 behavior.
--
-- WHY DROP-THEN-CREATE (not CREATE OR REPLACE): a Postgres function's identity
-- includes its input arg types, so CREATE OR REPLACE with the new 7-arg signature
-- would create a SECOND overload alongside the existing 6-arg function rather than
-- replacing it. A 6-arg call (the currently-deployed webhook, until Stage 2 ships,
-- and any Stripe replay) would then match BOTH the 6-arg fn AND the 7-arg fn (via
-- its default) -> "function grant_entitlement(...) is not unique" -> the live grant
-- path would 500. Dropping the old 6-arg signature first leaves exactly ONE
-- function, callable with 6 args (p_creator_id defaults NULL) OR 7 args ->
-- backward-compatible and unambiguous in every deploy order.
--
-- entitlements.creator_id is nullable, no default, FK -> creators(id) ON DELETE SET
-- NULL: NULL is accepted now; a real creator id is insertable later; a bogus id is
-- FK-rejected (a safety net for the active stage).

drop function if exists public.grant_entitlement(text, uuid, uuid, text, integer, text);

create function public.grant_entitlement(
  p_session_id text,
  p_user_id uuid,
  p_title_id uuid,
  p_kind text,
  p_price_cents integer,
  p_payment_intent_id text,
  p_creator_id uuid default null
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
    stripe_checkout_session_id, stripe_payment_intent_id, creator_id
  ) values (
    p_user_id, p_title_id, p_kind, p_price_cents,
    p_session_id, p_payment_intent_id, p_creator_id
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is null then
    return 'already_granted';
  end if;
  return 'granted';
end;
$$;

-- LOCKDOWN — reproduce EXACTLY the 20260626000003 grant state on the NEW 7-arg
-- signature (Supabase default privileges re-grant EXECUTE to anon+authenticated on
-- every new public.* function — revoke from all three, grant only to service_role).
-- Pre-migration ACL was {postgres=X, service_role=X} (PUBLIC/anon/authenticated
-- absent); this preserves it identically. No new roles, no broadening.
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text, uuid) from public;
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text, uuid) from anon;
revoke execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text, uuid) from authenticated;
grant execute on function public.grant_entitlement(text, uuid, uuid, text, integer, text, uuid) to service_role;

-- Transactions sub-unit 2 — viewer rental entitlements + idempotent grant RPC.
-- The FIRST money-moving unit's data model. PURELY ADDITIVE: a new table + a new
-- function; no change to any existing table or data.
--
-- `entitlements` records "this user holds a rental/purchase of this title". A
-- row is granted EXACTLY ONCE by the Stripe webhook on checkout.session.completed
-- via grant_rental_entitlement(), keyed on stripe_checkout_session_id — a
-- replayed webhook hits the UNIQUE and grants nothing new. The playback gate that
-- READS entitlements and enforces the two-clock rental window is sub-unit 3; this
-- migration grants but does NOT enforce anything at playback.

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  kind text not null check (kind in ('rental', 'purchase')),
  price_paid_cents integer not null check (price_paid_cents >= 0), -- integer cents, never float
  purchased_at timestamptz not null default now(),
  first_played_at timestamptz,            -- nullable; sub-unit 3 stamps on first play
  creator_id uuid references public.creators(id) on delete set null, -- nullable; sub-unit 5 attribution
  -- Idempotency key. A replayed checkout.session.completed grants nothing new
  -- (grant RPC does ON CONFLICT DO NOTHING on this column). A plain UNIQUE
  -- constraint is NON-DEFERRABLE by default — required for ON CONFLICT arbiter
  -- inference (a deferrable unique would break it).
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now()
);

-- Sub-unit-3 playback lookup: "does this user hold an entitlement for this title".
create index if not exists idx_entitlements_user_title
  on public.entitlements (user_id, title_id);

-- Service-role-only. The webhook writes via the service-role client (which
-- bypasses RLS), and the sub-unit-3 read is server-side via service-role too.
-- Enable RLS with NO policies so anon/authenticated have zero access — mirrors
-- transaction_attributions. (A money table is never client-readable/writable.)
alter table public.entitlements enable row level security;

-- Idempotent grant. SECURITY DEFINER so the service-role webhook can call it;
-- ON CONFLICT DO NOTHING makes a replay a clean no-op. Returns a discriminated
-- 'granted' | 'already_granted' (mirrors mux_finalize_asset_ready) so the webhook
-- logs-vs-acks. A genuine (non-conflict) insert failure RAISES, and the webhook
-- returns 500 → Stripe retries (the customer paid; we must eventually grant).
create or replace function public.grant_rental_entitlement(
  p_session_id text,
  p_user_id uuid,
  p_title_id uuid,
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
  insert into public.entitlements (
    user_id, title_id, kind, price_paid_cents,
    stripe_checkout_session_id, stripe_payment_intent_id
  ) values (
    p_user_id, p_title_id, 'rental', p_price_cents,
    p_session_id, p_payment_intent_id
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;

  if v_id is null then
    return 'already_granted';   -- replay: the unique conflict ate the insert
  end if;
  return 'granted';
end;
$$;

-- LOCKDOWN. Supabase ALTER DEFAULT PRIVILEGES re-grants EXECUTE to anon AND
-- authenticated on every new public.* function, so REVOKE FROM PUBLIC alone does
-- NOT undo them — revoke from all three roles explicitly, then grant only to
-- service_role (the confirm_campaign_funding_lockdown lesson). The webhook is the
-- sole caller, via the service-role client.
revoke execute on function public.grant_rental_entitlement(text, uuid, uuid, integer, text) from public;
revoke execute on function public.grant_rental_entitlement(text, uuid, uuid, integer, text) from anon;
revoke execute on function public.grant_rental_entitlement(text, uuid, uuid, integer, text) from authenticated;
grant execute on function public.grant_rental_entitlement(text, uuid, uuid, integer, text) to service_role;

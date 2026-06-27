-- Sub-unit 5a — the per-entitlement settlement ledger.
--
-- One immutable row per settled entitlement: the integer-cents split of a
-- completed transaction into the three payout legs (moonbeem_take,
-- distributor_net, affiliate_cut) plus the Stripe processing fee, every leg
-- after the first derived by subtraction so they sum to gross by construction.
-- Computed at settlement (a deferred pass), NOT at grant. This migration moves
-- no money and inserts no rows; sub-unit 5b advances payout_status and executes
-- the transfers.
--
-- Idempotent per entitlement: entitlement_id is UNIQUE, so the settle pass uses
-- INSERT ... ON CONFLICT (entitlement_id) DO NOTHING (the sub-unit 4 pattern).
--
-- Rates are SNAPSHOTTED as INTEGER BASIS POINTS (10% = 1000, 15% = 1500) into
-- the row, never referenced by a live foreign key: a later title rate change
-- must not retroactively alter recorded settlements. The ledger is immutable
-- history. The compute is integer-only: floor(post_fee_cents * bps / 10000).
--
-- creator_share_bps DEFAULT 0 is a 5a CONVENIENCE for the current
-- no-affiliate-producer state: entitlements.creator_id has no producer yet, so
-- every 5a settlement is creator_id NULL / affiliate_cut = 0. It is NOT the
-- eventual semantics. Once attribution exists, an affiliate purchase writes the
-- actual snapshotted bps, and the producer must treat a creator_id-set row whose
-- creator_share_bps = 0 as INVALID.
--
-- payout_status is advanced by sub-unit 5b; its full enum value set is confirmed
-- in a later step. Default 'held' = recorded but not yet payable (held until
-- past the 14-day refund/dispute window).
--
-- partner_id is NULLABLE (the distributor). Recon: titles.partner_id is itself
-- nullable with ON DELETE SET NULL, and there are currently 0 transacting
-- titles, so a non-null distributor cannot be guaranteed at the DB level. A
-- NOT NULL constraint here would let a deleted-partner title BLOCK the ledger
-- write at settle time; the settle pass instead HOLDS any null-partner row for
-- manual handling. (The money-rail rule: never block a settlement record.)
--
-- FOREIGN KEYS ARE NO ACTION (no cascade, no set-null) — a deliberate departure
-- from the old transaction_attributions table's ON DELETE CASCADE. An immutable
-- financial ledger must not be deleted or mutated by deletion of a referenced
-- entity; deletion of a referent is blocked while a settlement references it.

create table if not exists public.transaction_settlements (
  id                    uuid primary key default gen_random_uuid(),

  -- Idempotency key: exactly one settlement per entitlement.
  entitlement_id        uuid not null unique references public.entitlements(id),
  title_id              uuid not null references public.titles(id),
  partner_id            uuid references public.partners(id),   -- distributor; NULLABLE (see header)
  creator_id            uuid references public.creators(id),   -- affiliate; null = no affiliate

  -- Integer cents. gross = what the buyer paid (entitlements.price_paid_cents);
  -- post_fee = Stripe's reported net; stripe_fee = gross - post_fee. The three
  -- payout legs are each derived by subtraction.
  gross_cents           integer not null,
  post_fee_cents        integer not null,
  stripe_fee_cents      integer not null,
  moonbeem_take_cents   integer not null,
  distributor_net_cents integer not null,
  affiliate_cut_cents   integer not null,

  -- Snapshotted rates, integer basis points (15% = 1500).
  moonbeem_take_bps     integer not null,
  creator_share_bps     integer not null default 0,

  payout_status         text not null default 'held',
  stripe_balance_txn_id text,
  settled_at            timestamptz not null default now(),

  -- Per-column non-negativity (all cents columns and both bps columns).
  constraint transaction_settlements_gross_nonneg           check (gross_cents >= 0),
  constraint transaction_settlements_post_fee_nonneg        check (post_fee_cents >= 0),
  constraint transaction_settlements_stripe_fee_nonneg      check (stripe_fee_cents >= 0),
  constraint transaction_settlements_moonbeem_take_nonneg   check (moonbeem_take_cents >= 0),
  constraint transaction_settlements_distributor_net_nonneg check (distributor_net_cents >= 0),
  constraint transaction_settlements_affiliate_cut_nonneg   check (affiliate_cut_cents >= 0),
  constraint transaction_settlements_moonbeem_bps_nonneg    check (moonbeem_take_bps >= 0),
  constraint transaction_settlements_creator_bps_nonneg     check (creator_share_bps >= 0),

  -- The sum invariant, DB-enforced: the Stripe fee plus the three payout legs
  -- reconstruct gross exactly. True by construction in the algorithm; enforced
  -- here so the DB is the authority.
  constraint transaction_settlements_sum_invariant
    check (
      stripe_fee_cents + moonbeem_take_cents + distributor_net_cents + affiliate_cut_cents
      = gross_cents
    )
);

-- Service-role-only, like entitlements: enable RLS with NO policies so the
-- financial ledger is never exposed through the PostgREST anon/auth API. The
-- settle pass (sub-unit 5b/service role) bypasses RLS.
alter table public.transaction_settlements enable row level security;

-- Applied to prod via apply_migration (recorded version 20260705234120); prefix
-- aligned so `db push` will not re-run it.
--
-- Tips ride transaction_settlements. A tip is a settlement with entitlement_id +
-- title_id NULL and tip_id set: gross = affiliate_cut (creator owed 100%),
-- stripe_fee = moonbeem_take = distributor_net = 0 (Moonbeem absorbs the Stripe
-- fee; the real absorbed cost is on tips.stripe_fee_absorbed_cents). This keeps
-- the balance/withdraw/maturity/clawback rails UNCHANGED — a tip is just an
-- affiliate_cut row those rails already read.
alter table public.transaction_settlements
  alter column entitlement_id drop not null,
  alter column title_id drop not null,
  add column tip_id uuid references public.tips(id);

-- Exactly one funding source per settlement: a sale (entitlement_id) or a tip
-- (tip_id), never both, never neither. All existing rows carry entitlement_id.
alter table public.transaction_settlements
  add constraint transaction_settlements_one_source
    check (num_nonnulls(entitlement_id, tip_id) = 1);

-- Idempotency for tips: at most one settlement per tip (mirrors the
-- entitlement_id unique). Partial, so the many sale rows (tip_id NULL) are free.
create unique index transaction_settlements_tip_id_key
  on public.transaction_settlements(tip_id)
  where tip_id is not null;

-- SEMANTICS ON THE RECORD: stripe_fee_cents is the fee borne WITHIN the
-- distribution split. On TIP rows it is 0 — Moonbeem absorbs the processing fee
-- rather than charging the creator (owed 100% of the gross tip). The real
-- absorbed fee lives on tips.stripe_fee_absorbed_cents. A reconciler of actual
-- Stripe fees MUST read tip rows' fee from tips, not treat them as fee-free.
comment on column public.transaction_settlements.stripe_fee_cents is
  'Fee borne WITHIN the distribution split. 0 on tip rows (Moonbeem absorbs it; real absorbed fee on tips.stripe_fee_absorbed_cents).';

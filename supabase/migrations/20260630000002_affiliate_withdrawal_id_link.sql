-- Layer 3 Stage 1 — link a paid affiliate cut to the withdrawal that paid it.
--
-- transaction_settlements.withdrawal_id: NULL until a Layer 3 withdrawal pays the
-- cut, then set to that withdrawal's id when payout_status flips 'held' -> 'paid'.
-- PREREQUISITE for the clawback (Stage 3): when a paid cut's rental is later
-- refunded/disputed, the 'reversed' marking + recovery must know WHICH withdrawal
-- paid it. Nullable + FK -> withdrawals(id) ON DELETE NO ACTION — matching every
-- other FK on this immutable ledger (a withdrawal that paid cuts must not be
-- deletable). Additive + non-destructive: existing rows get NULL, no row rewrite,
-- no CHECK / grant / RLS change. Applied via the runner's single transaction.

alter table public.transaction_settlements
  add column withdrawal_id uuid null
    references public.withdrawals (id) on delete no action;

comment on column public.transaction_settlements.withdrawal_id is
  'The withdrawal that paid this affiliate cut (NULL = not yet paid). Set when '
  'payout_status flips held->paid; the clawback path uses it to find/reverse a '
  'paid cut on a later refund/dispute.';

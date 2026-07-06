-- Applied to prod via apply_migration (recorded version 20260705234051); this
-- file's prefix is aligned so `db push` will not re-run it.
--
-- Tips build (fenced money session). Rework the vestigial `tips` table
-- (initial_schema 20260424000001, 0 rows, numeric-USD, never wired) into
-- money-integer tip provenance + Moonbeem's absorbed-fee record. The tip PAYOUT
-- itself rides transaction_settlements (affiliate_cut = gross; creator owed
-- 100%); this table holds provenance (payer, message, fan-edit) + the absorbed
-- Stripe fee.
alter table public.tips
  drop column amount_usd,
  drop column platform_fee_usd,
  drop column creator_payout_usd,
  add column amount_cents integer not null,
  add column payer_user_id uuid references public.users(id) on delete set null,
  add column stripe_fee_absorbed_cents integer,
  add column stripe_checkout_session_id text,
  add column receipt_url text,
  add column paid_at timestamptz;

alter table public.tips
  add constraint tips_amount_cents_positive
    check (amount_cents > 0),
  add constraint tips_absorbed_fee_nonneg
    check (stripe_fee_absorbed_cents is null or stripe_fee_absorbed_cents >= 0),
  add constraint tips_status_check
    check (status in ('pending', 'paid', 'refunded', 'disputed')),
  add constraint tips_message_len
    check (message is null or char_length(message) <= 280);

create unique index tips_stripe_checkout_session_id_key
  on public.tips(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

comment on column public.tips.stripe_fee_absorbed_cents is
  'Real Stripe processing fee Moonbeem ABSORBED on this tip (creator receives 100% of gross). NOT charged to the creator; the settlement row carries stripe_fee_cents=0.';
comment on column public.tips.payer_user_id is
  'The tipping fan (nullable for future guest tips; v1 route requires auth).';

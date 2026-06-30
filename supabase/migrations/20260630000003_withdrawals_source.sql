-- Layer 3 Stage 2a — withdrawals.source marker (campaign vs affiliate).
--
-- Distinguishes a CAMPAIGN withdrawal (pays creator_earnings) from an AFFILIATE
-- withdrawal (pays transaction_settlements). Without it the two withdraw rails
-- cross-block via the shared per-creator no-pending guard (a pending campaign
-- withdrawal would block an affiliate one and vice versa, though they pay
-- different row sets). NOT NULL DEFAULT 'campaign' so every existing row + the
-- otherwise-unchanged campaign rail keep working; a CHECK limits source to the
-- two valid values. Additive + non-destructive (existing rows -> 'campaign', no
-- grant/RLS change). Applied via the runner's single transaction.

alter table public.withdrawals
  add column source text not null default 'campaign';

alter table public.withdrawals
  add constraint withdrawals_source_check
    check (source in ('campaign', 'affiliate'));

comment on column public.withdrawals.source is
  'Which rail created this withdrawal: campaign (pays creator_earnings) or affiliate (pays transaction_settlements). Each rail scopes its no-pending guard to its own source so they do not cross-block.';

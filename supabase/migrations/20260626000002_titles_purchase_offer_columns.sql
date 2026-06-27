-- Transactions sub-unit 4 — purchase offer columns on titles, mirroring the
-- rental pair (transact_enabled / transact_price_cents). A title can now offer
-- rent, buy, or BOTH. PURELY ADDITIVE: both columns are new; the NOT NULL default
-- (constant false) is a metadata-only change (no table rewrite on the 1.4M-row
-- catalog). No change to entitlements (kind CHECK already allows 'purchase').
alter table public.titles
  add column if not exists purchase_enabled boolean not null default false,
  add column if not exists purchase_price_cents integer;

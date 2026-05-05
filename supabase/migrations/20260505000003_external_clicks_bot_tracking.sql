-- Affiliate-clicks v1: extend external_clicks for bot tracking, country
-- attribution, and creator-attributed direct offer clicks (Flow B).
--
-- New columns:
--   is_bot          — write-time classification via bot UA detection
--                     (src/lib/bot-detection.ts). Default queries filter
--                     to is_bot=false; raw counts stay queryable.
--   bot_signature   — which UA pattern matched, for debugging
--                     ('slackbot', 'twitterbot', 'curl/', 'empty-ua', etc.).
--                     Null when is_bot=false.
--   country_code    — Vercel geo header x-vercel-ip-country. Free, useful
--                     for international titles. Existing schema already
--                     has city + region_code from the same source.
--   creator_id      — Flow B (creator profile offer button click): we
--                     attribute the click to a creator without minting an
--                     affiliate_links row. Null on Flows A (anonymous
--                     offer click) and C (handled via affiliate_link_id
--                     -> affiliate_links.creator_id).
--                     ON DELETE SET NULL: preserve historical click
--                     attribution if a creator account is deleted.
--
-- New indexes:
--   (title_id, clicked_at desc)        — admin "top titles" rollup
--   (affiliate_link_id, clicked_at desc) where not null — creator
--                                        affiliate-link rollup (Flow C)
--   (creator_id, clicked_at desc) where not null — direct creator
--                                        attribution rollup (Flow B)

alter table public.external_clicks
  add column if not exists is_bot boolean not null default false,
  add column if not exists bot_signature text,
  add column if not exists country_code text,
  add column if not exists creator_id uuid references public.creators(id) on delete set null;

create index if not exists idx_external_clicks_title_clicked
  on public.external_clicks (title_id, clicked_at desc);

create index if not exists idx_external_clicks_affiliate_clicked
  on public.external_clicks (affiliate_link_id, clicked_at desc)
  where affiliate_link_id is not null;

create index if not exists idx_external_clicks_creator_clicked
  on public.external_clicks (creator_id, clicked_at desc)
  where creator_id is not null;

-- Affiliate-links extensions: per-offer attribution, audit trail, soft delete.
--
-- title_offer_id: per-offer analytics (e.g. distinguish a creator's
--   Apple TV link from their Fandango link for the same title).
--   ON DELETE SET NULL: preserve historical link rows + click rows
--   when an offer is deactivated upstream.
--
-- created_by: audit trail for who minted the link. Future creator
--   dashboard might mint links on behalf of a creator (admin-curated
--   campaign), or a migration / seed script might pre-populate them.
--   Distinct from creator_id (the attributee). Null = unknown / pre-
--   instrumentation. ON DELETE SET NULL: deleting a user shouldn't
--   delete the link or break attribution.
--
-- deleted_at: soft delete for link rotation. The /go/[code] handler
--   filters WHERE deleted_at IS NULL so a soft-deleted link 404s,
--   while external_clicks.affiliate_link_id rows stay valid (their
--   FK with ON DELETE SET NULL is for hard deletes, which we now
--   avoid).

alter table public.affiliate_links
  add column if not exists title_offer_id uuid
    references public.title_offers(id) on delete set null,
  add column if not exists created_by uuid
    references public.users(id) on delete set null,
  add column if not exists deleted_at timestamptz;

create index if not exists idx_affiliate_links_title_offer
  on public.affiliate_links (title_offer_id)
  where title_offer_id is not null;

create index if not exists idx_affiliate_links_active
  on public.affiliate_links (creator_id, title_id)
  where deleted_at is null;

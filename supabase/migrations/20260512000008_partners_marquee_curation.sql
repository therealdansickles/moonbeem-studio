-- Partner marquee curation: replace the hardcoded MARQUEE_PARTNER_ORDER
-- array in src/lib/queries/partners.ts with DB-driven order.
--
-- The pitch-day hardcoded list (2026-05-12 Emerson Collective) needs
-- to become editable now that we have super-admin curation patterns
-- (mirrors the Featured carousel work from this session).
--
-- Two columns:
--   - marquee_order   INT — append-to-end semantics (max+1 on
--                            visibility flip false→true); ORDER BY
--                            ASC on the homepage strip.
--   - is_marquee_visible BOOL — admin can keep a partner without
--                            surfacing them in the strip. Default
--                            true so new partners auto-marquee.
--
-- Backfill preserves today's exact homepage order. The 8 hardcoded
-- slugs get marquee_order 1..8 in array order; any other existing
-- partner gets is_marquee_visible=false (today they aren't on the
-- strip, mustn't be after migration). Admin can opt them in via the
-- /admin/marquee page.

alter table public.partners
  add column if not exists marquee_order integer not null default 0;

alter table public.partners
  add column if not exists is_marquee_visible boolean not null default true;

-- Existing partners not in the hardcoded list weren't on the strip;
-- preserve that by setting visible=false for everyone first. The
-- subsequent UPDATE re-enables the 8 hardcoded slugs.
update public.partners
set is_marquee_visible = false
where is_marquee_visible = true
  and marquee_order = 0;  -- idempotent: skip rows already backfilled

-- Backfill the 8 hardcoded slugs with their array-position order.
-- The CASE WHEN list mirrors MARQUEE_PARTNER_ORDER from
-- src/lib/queries/partners.ts exactly.
update public.partners p
set
  is_marquee_visible = true,
  marquee_order = case p.slug
    when 'magnolia-pictures'        then 1
    when 'oscilloscope-laboratories' then 2
    when 'optimist'                  then 3
    when 'roadside-attractions'      then 4
    when 'topic-studios'             then 5
    when '1-2-special'               then 6
    when 'mitten-media'              then 7
    when 'dpop-studios'              then 8
  end
where p.slug in (
  'magnolia-pictures', 'oscilloscope-laboratories', 'optimist',
  'roadside-attractions', 'topic-studios', '1-2-special',
  'mitten-media', 'dpop-studios'
);

create index if not exists idx_partners_marquee_order
  on public.partners (marquee_order)
  where is_marquee_visible = true;

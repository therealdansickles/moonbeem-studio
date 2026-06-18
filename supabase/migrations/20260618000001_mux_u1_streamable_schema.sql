-- Mux U1 — streamable-asset schema. PURELY ADDITIVE, money-rail-free.
--
-- title_episodes holds HETEROGENEOUS playable sources. Instagram episodes are a
-- current, first-class content type (embed_url, plays in a modal, free, no DRM).
-- Mux is the NEW source added alongside it (mux_playback_id, signed-token
-- playback, may require DRM, may later be transactional). Both are real.
--
-- This migration INTRODUCES the new governing fields (inert in v1 — only 'free'/
-- NULL emitted) but does NOT retire the legacy fields:
--   * access (frozen at 'free', NOT widened/removed here — vestigial, removed in
--     a later dedicated cleanup with its own blast-radius check). monetization_mode
--     governs gating going forward.
--   * transact_enabled / transact_price_cents / creator_share_pct /
--     moonbeem_take_rate_pct stay; default_monetization_mode is the MODE selector
--     and the transact_* fields are the PARAMETERS used when mode='transactional'.
--     transact_enabled is redundant/derived, deprecated later (not here).
--
-- RESOLUTION RULE (documented; NO logic built in U1, nothing reads it yet):
--   effective asset monetization mode =
--     COALESCE(title_episodes.monetization_mode, titles.default_monetization_mode)
--   The asset override is source of truth for gating; the title default is a
--   convenience. U3 reads this later.
--
-- NOT in U1: no Mux API/ingest/webhook/signing/player/modal changes, no
-- transaction/rental/bundle/entitlement/checkout, no AVOD logic, no changes to
-- canViewTitle/is_public/partner_id. Values other than 'free'/NULL must not be
-- emitted or read in v1.

-- 1. New title_episodes columns.
alter table public.title_episodes
  add column if not exists mux_asset_id      text,
  add column if not exists mux_playback_id   text,
  add column if not exists monetization_mode text,        -- NULL = inherit title default
  add column if not exists requires_drm      boolean not null default false;

-- 2. embed_url becomes per-source (Mux rows carry none). The table-level NOT NULL
--    is dropped and re-imposed for instagram rows by the shape CHECK below, so
--    every current/future Instagram row keeps the guarantee.
alter table public.title_episodes alter column embed_url drop not null;

-- 3. Widen source — DO NOT remove 'instagram' (current first-class source).
alter table public.title_episodes drop constraint if exists title_episodes_source_check;
alter table public.title_episodes add constraint title_episodes_source_check
  check (source in ('instagram','mux'));

-- 4. monetization_mode: NULL (inherit) or one of three. Only free/NULL emitted in v1.
alter table public.title_episodes drop constraint if exists title_episodes_monetization_mode_check;
alter table public.title_episodes add constraint title_episodes_monetization_mode_check
  check (monetization_mode is null or monetization_mode in ('free','transactional','avod'));

-- 5. Per-source integrity: a row is structurally instagram XOR mux, never both.
--    mux: playback_id required (the playable handle), embed_url NULL; asset_id
--    nullable (arrives at/after ingest — a mux row is only inserted once playable;
--    U2 tracks in-flight uploads elsewhere until video.asset.ready yields the id).
alter table public.title_episodes drop constraint if exists title_episodes_source_shape_check;
alter table public.title_episodes add constraint title_episodes_source_shape_check
  check (
    (source = 'instagram'
       and embed_url is not null
       and mux_asset_id is null and mux_playback_id is null)
    or
    (source = 'mux'
       and mux_playback_id is not null
       and embed_url is null)
  );

-- 6. titles: title-level default monetization mode. Assets inherit when their
--    override is NULL (see COALESCE rule above).
alter table public.titles
  add column if not exists default_monetization_mode text not null default 'free';
alter table public.titles drop constraint if exists titles_default_monetization_mode_check;
alter table public.titles add constraint titles_default_monetization_mode_check
  check (default_monetization_mode in ('free','transactional','avod'));

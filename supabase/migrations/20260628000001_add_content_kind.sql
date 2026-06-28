-- Add titles.content_kind — a STORED, DECLARED hosting/distribution axis,
-- orthogonal to media_type (which is the format axis: movie|tv|event).
--
-- WHY a stored field, not derived: a title's hosting model must be known BEFORE
-- any episode lands. Deriving from title_episodes.source fails exactly when we
-- need it — an empty film draft (no episodes yet) has no source to read. All 25
-- partner films are currently empty, so derivation would classify every one as
-- "unknown". A declared column answers "what is this draft" at creation time.
--
-- Values:
--   'film'  — DRM/Mux-hosted (uploads a film, gets territories + rental/purchase
--             pricing; NO Instagram-episode box).
--   'embed' — Instagram/social-hosted (e.g. Watch Hill; gets the Instagram-
--             episode box; typically not transaction-gated, media is free elsewhere).
--
-- BEHAVIORALLY INERT: nothing reads content_kind yet. The surface conditionals
-- (gate the admin Instagram box / partner film controls on this value) are a
-- SEPARATE follow-up build. This migration changes no rendering and no gating.

-- 1. Column with a CONSTANT default → metadata-only add on the ~1.44M-row table
--    (no full table rewrite in modern Postgres). New titles default to 'film',
--    matching the partner upload flow's film-first creation path.
alter table public.titles
  add column content_kind text not null default 'film';

-- 2. CHECK constraint — minimal, forward-compatible value set. A future kind
--    (e.g. 'live') is a one-line constraint swap; series/season granularity and
--    events are deliberately NOT modeled here (series is a media_type/format
--    concern, hosting-agnostic).
alter table public.titles
  add constraint titles_content_kind_check
  check (content_kind in ('film', 'embed'));

-- 3. Backfill the embed titles, keyed on EPISODE SOURCE (self-documenting, and
--    survives a future Instagram-hosted movie that media_type alone would
--    mislabel): a title is 'embed' iff it has at least one source='instagram'
--    episode AND zero source='mux' episodes. Everything else keeps 'film'.
--    On the live catalog this matches EXACTLY ONE row: watch-hill-2026
--    (39 instagram episodes, 0 mux). The 25 partner films (all empty) and the
--    ~1.44M TMDB engagement rows (no episodes) keep the default 'film'.
update public.titles t
   set content_kind = 'embed'
 where exists (
         select 1 from public.title_episodes e
          where e.title_id = t.id and e.source = 'instagram'
       )
   and not exists (
         select 1 from public.title_episodes e
          where e.title_id = t.id and e.source = 'mux'
       );

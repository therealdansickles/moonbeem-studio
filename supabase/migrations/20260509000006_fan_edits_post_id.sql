-- fan_edits.post_id: platform-native id extracted from embed_url.
--
-- For TikTok this is the aweme_id; Instagram the post shortcode;
-- Twitter the tweet id; YouTube the 11-char video id. Used by the
-- /admin Discover-tab dedupe (search candidates carry post_id
-- natively from EnsembleData responses, but legacy / CSV-imported
-- rows have URLs with mobile hosts, query params, tracking strings
-- — embed_url string-equality misses every variant). post_id is
-- the canonical "is this the same TikTok video?" check across all
-- import paths.
--
-- Backfill via PostgreSQL regex on embed_url. Patterns mirror
-- src/lib/ensembledata/client.ts's parseShortcodeFromUrl.
--
-- Followed by:
--   1) soft-delete pre-existing duplicate rows so the partial
--      unique index can create. Keeper rule:
--        ORDER BY view_count DESC NULLS LAST, created_at DESC
--      i.e. highest current views; tiebreak newest. Defends
--      partner-dashboard metric continuity (see commit body).
--   2) unique partial index on (title_id, post_id) WHERE
--      post_id IS NOT NULL AND deleted_at IS NULL — defense in
--      depth so CSV / view-tracking / future paths can never
--      re-introduce duplicates even if app-level dedupe regresses.
--
-- The 4 soft-deleted rows (all on Erupcja, all with identical
-- view_count to their kept twin) become eligible for hard-delete
-- after a 30-day retention window — captured in followup queue.

-- ---------------------------------------------------------------
-- Column + backfill
-- ---------------------------------------------------------------

alter table public.fan_edits
  add column if not exists post_id text;

update public.fan_edits set post_id = case
  when platform = 'tiktok' then
    (regexp_match(embed_url, '/video/([0-9]+)'))[1]
  when platform = 'instagram' then
    (regexp_match(embed_url, '/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)'))[1]
  when platform = 'twitter' then
    (regexp_match(embed_url, '/status/([0-9]+)'))[1]
  when platform = 'youtube' then coalesce(
    (regexp_match(embed_url, '[?&]v=([A-Za-z0-9_-]{11})'))[1],
    (regexp_match(embed_url, '/(?:shorts|embed|v|live)/([A-Za-z0-9_-]{11})'))[1],
    (regexp_match(embed_url, 'youtu\.be/([A-Za-z0-9_-]{11})'))[1]
  )
  else null
end
where post_id is null and embed_url is not null;

-- ---------------------------------------------------------------
-- Soft-delete pre-existing duplicates
-- ---------------------------------------------------------------
-- Keeper per (title_id, post_id) is the row with highest view_count
-- (tiebreak: newest created_at). Re-running the migration is a
-- no-op since previously-soft-deleted rows fall out of the partition
-- scan via the WHERE deleted_at IS NULL filter on the CTE source.

with ranked as (
  select id,
    row_number() over (
      partition by title_id, post_id
      order by view_count desc nulls last, created_at desc
    ) as rn
  from public.fan_edits
  where deleted_at is null and post_id is not null
)
update public.fan_edits f
  set deleted_at = now()
  from ranked r
  where f.id = r.id and r.rn > 1;

-- ---------------------------------------------------------------
-- Unique partial index
-- ---------------------------------------------------------------
-- Scope: (title_id, post_id) for live, post_id-bearing rows. The
-- same TikTok attached to a DIFFERENT title is intentionally
-- allowed (multi-title attribution from 2.2's dedupe-within-title
-- decision).

create unique index if not exists fan_edits_title_post_id_uniq
  on public.fan_edits (title_id, post_id)
  where post_id is not null and deleted_at is null;

-- Add Star Cash and The Carpenter's Son to the homepage Featured
-- carousel.
--
-- Both titles have active fan_edits surfacing in the Recent Remixes
-- carousel but the parent titles weren't appearing in Featured — a
-- visible inconsistency on the homepage.
--
-- Applied via ad-hoc UPDATE in Supabase Studio at 2026-05-12T02:40Z
-- before this file landed in git. Replaying is idempotent (the
-- WHERE filters skip rows already featured / not public / not active).
--
-- Featured carousel mechanism (getFeaturedTitles in
-- src/lib/queries/titles.ts:171): SELECT * FROM titles WHERE
-- is_featured = true AND is_active = true ORDER BY created_at ASC.
-- The two newly-featured titles slot into positions 4 (Carpenter's
-- Son, created 2026-04-29 20:57:27) and 9 (Star Cash, created
-- 2026-04-29 21:01:29). The reorder UI + display_order column are
-- deferred to the homepage v2 scoping conversation.

update public.titles
   set is_featured = true
 where slug in ('star-cash-2026', 'the-carpenter-s-son-2025')
   and is_featured = false
   and is_public = true
   and is_active = true;

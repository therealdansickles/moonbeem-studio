-- Soft-delete 6 OBEX (Albert Birney film, 2026, Oscilloscope) fan_edits
-- that were noise from a name collision with the musical artist @obex
-- on YouTube. Each of the 6 rows was a music track from the @obex
-- channel (Latin one-word titles: Incision, Abyssus, Desperatio,
-- Judicium, Oppression, Lapsus) — caught in OBEX hashtag-search during
-- Block A.1 Discover sourcing but not film-related.
--
-- Applied via ad-hoc SQL in Supabase Studio at 2026-05-11T12:50:42Z
-- due to a dropped handoff from the prior session — the stop-and-verify
-- gate ("soft-delete now, or hold for @hallowed secrets decision?") never
-- closed before the conversation moved on. This migration file documents
-- intent for git history; replaying it is idempotent (WHERE deleted_at
-- IS NULL guard makes the UPDATE a no-op on already-deleted rows).
--
-- Pre-state (verified 2026-05-11):
--   OBEX YouTube rows where creator_handle_displayed = 'obex':
--     affa2475-… b7jN6EGnlhM (42 views)
--     cd6d310e-… P4jXRzxPR5A (70 views)
--     24e26bbe-… NJsWg3pHAHM (69 views)
--     017dd6f8-… Kn2jTWPjbAQ (20 views)
--     1addf38a-… b8HqIJ1WMRI (23 views)
--     6db9aefd-… LY9tOAsCNbs (45 views)
--
-- Post-state: OBEX live fan_edits 18 → 12. @hallowed secrets ("OBEX
-- FULL MOVIE" piracy SEO row) was deleted separately in a prior
-- session.

update public.fan_edits
  set deleted_at = '2026-05-11T12:50:42.143696+00:00'::timestamptz
  where id in (
    'affa2475-2f6f-425a-b1da-57df59e8a6c5'::uuid,
    'cd6d310e-94b8-4dcd-a299-7fa0f7e1703f'::uuid,
    '24e26bbe-9fb2-4526-a37a-61f8d1e43e84'::uuid,
    '017dd6f8-1e47-4006-9af0-3cd4286bc8db'::uuid,
    '1addf38a-08dc-4472-8ff0-85dc27257c65'::uuid,
    '6db9aefd-7d67-4652-b2e5-bbb604ebc3de'::uuid
  )
  and deleted_at is null;

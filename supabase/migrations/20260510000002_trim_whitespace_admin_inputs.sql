-- One-shot retroactive cleanup of trailing whitespace on user-input
-- string fields. Code-side .trim() landed on the corresponding admin
-- write paths in the same commit (clips, stills, fan_edits CSV
-- importer already had trim via getCol, Discover/add caption,
-- search.ts TikTok+YouTube parser captions).
--
-- Pre-state (verified via scripts/audit-whitespace.mjs against prod
-- 2026-05-10):
--   clips.label: 1 row tainted
--     "TEST Official Teaser 2 (carpenter's son) "
--     (Rohan's Carpenter's Son test upload, see followup memory
--     "Trailing whitespace on admin upload labels")
--   fan_edits.caption: 5 rows tainted (Erupcja TikTok/IG captions
--     where the source post body had trailing whitespace)
--   stills.alt_text, partners.name, creators.{display_name,
--     moonbeem_handle}, fan_edits.creator_handle_displayed,
--     titles.title (where is_active): clean
--
-- Active titles (n=8) audited explicitly; full catalog (1.4M rows)
-- skipped because the ilike scan timed out without an index. Active
-- subset is the only realistic source of admin-input title strings.
--
-- WHERE clause guards make the UPDATE idempotent — replays are no-ops.

update public.clips
  set label = trim(label)
  where label is not null
    and label <> trim(label);

update public.fan_edits
  set caption = trim(caption)
  where caption is not null
    and caption <> trim(caption);

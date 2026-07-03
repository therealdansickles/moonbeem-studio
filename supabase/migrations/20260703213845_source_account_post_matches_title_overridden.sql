-- Review Queue v2 (correct-the-title): provenance for a manual title override at
-- confirm time. Default false = every existing + auto-confirmed row is honestly
-- labeled with zero backfill. Combined with the retained matched_title_id +
-- match_confidence, this gives the full extractor-quality tuple in one row (suggested
-- title X at confidence C, human accepted [false] or corrected to Y [true, Y
-- recoverable via confirmed_fan_edit_id -> fan_edits.title_id]).
--
-- Applied to prod via apply_migration (recorded version 20260703213845); this file's
-- prefix is aligned to that version so `db push` will not re-run it.
alter table public.source_account_post_matches
  add column if not exists title_overridden boolean not null default false;

-- Split the single 'clips_and_stills' title_requests.request_type into two
-- independent types, 'clips' and 'stills'. A clean cut, NOT a data migration:
-- prod holds 0 clips_and_stills rows (only fan_edits), so no existing row
-- violates the new CHECK and none needs re-bucketing. 'clips_and_stills' is
-- dropped entirely rather than kept for back-compat.
--
-- Single transaction (the migration runner wraps it): drop the old CHECK,
-- add the new one. fan_edits is unchanged.

alter table public.title_requests
  drop constraint title_requests_request_type_check;

alter table public.title_requests
  add constraint title_requests_request_type_check
  check (request_type = any (array['fan_edits', 'clips', 'stills']));

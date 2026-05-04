-- Future-proof title_requests for the second CTA: a user must be able
-- to file both a 'fan_edits' and a 'clips_and_stills' request for the
-- same title. Today the unique constraint is (title_id, user_id),
-- which would reject the second one with 23505.
--
-- Atomic swap: drop the old constraint, add the new one, assert the
-- row count is unchanged. The Supabase CLI wraps each migration in a
-- transaction, so the whole DO block runs in a single tx — if the
-- count check fails, raising aborts the tx and nothing is committed.

do $$
declare
  before_count int;
  after_count int;
begin
  select count(*) into before_count from public.title_requests;

  alter table public.title_requests
    drop constraint title_requests_unique_per_user;

  alter table public.title_requests
    add constraint title_requests_unique_per_user_type
    unique (title_id, user_id, request_type);

  select count(*) into after_count from public.title_requests;

  if before_count <> after_count then
    raise exception
      'title_requests row count changed during constraint swap: % -> %',
      before_count, after_count;
  end if;
end $$;

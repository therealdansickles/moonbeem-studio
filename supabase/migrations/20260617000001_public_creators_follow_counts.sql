-- Follow feature — Step 3: expose the denormalized follow counters through the
-- public_creators view so the (anon-readable) profile fetch picks them up with
-- no extra round trip. The view is owned by postgres and bypasses creators RLS,
-- which is how anon already reads the profile shell — counts ride the same path.
-- Counts are public (consistent with the open profile). CREATE OR REPLACE VIEW
-- appends the two columns at the end and preserves existing grants.

create or replace view public.public_creators as
  select id,
         user_id,
         moonbeem_handle,
         is_stub,
         is_claimed,
         profile_kind,
         created_at,
         follower_count,
         following_count
  from public.creators
  where deleted_at is null;

-- Add self-update RLS policy on public.users so authenticated users can
-- update their own profile row. Without this, RLS silently blocks the
-- UPDATE: the query returns success with 0 rows affected.

drop policy if exists "Users can update their own row"
  on public.users;

create policy "Users can update their own row"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

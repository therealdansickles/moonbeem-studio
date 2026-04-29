alter table public.users enable row level security;

drop policy if exists "Users can read their own row" on public.users;
create policy "Users can read their own row"
  on public.users for select
  using (auth.uid() = id);

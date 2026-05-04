-- Allow authenticated users to read their own title_requests rows.
-- Required for the alreadyRequested check on title pages.

create policy title_requests_self_read
  on public.title_requests for select
  using (auth.uid() = user_id);

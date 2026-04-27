-- Public-read policies for titles and title_offers.
-- Anon and authenticated can read active rows only.
-- Inactive rows (soft-hidden) are denied to client roles; service role bypasses.
-- Closes part of issue #6 (titles + title_offers only; other tables get policies later).

create policy "titles are publicly readable when active"
  on public.titles
  for select
  to anon, authenticated
  using (is_active = true);

create policy "title_offers are publicly readable when active"
  on public.title_offers
  for select
  to anon, authenticated
  using (is_active = true);

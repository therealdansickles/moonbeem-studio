alter table public.stills
  add column if not exists content_type text;

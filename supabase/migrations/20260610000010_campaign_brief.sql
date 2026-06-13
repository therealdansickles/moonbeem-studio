-- CF-1: campaigns.brief — display-only free text shown on the public
-- /t/[slug]/campaign page. NOT read by any money path: fund/webhook/
-- metering operate only on *_cents columns + status (recon CF-0 proved
-- no money path reads a text column). Nullable; capped at 2000 chars by
-- a CHECK so the column can't bloat the row or smuggle a large payload
-- onto a public surface.
alter table public.campaigns
  add column brief text null
  check (brief is null or char_length(brief) <= 2000);

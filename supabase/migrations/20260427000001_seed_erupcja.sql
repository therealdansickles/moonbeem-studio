-- Seed Erupcja as the first title and primary case study.
-- Idempotent: re-running will overwrite the title row by slug
-- and replace all title_offers rows for this title.
-- Source: 1-2 Special distributor page, TIFF 2025 program notes.

insert into public.titles (
  slug,
  title,
  year,
  distributor,
  poster_url,
  synopsis,
  runtime_min,
  director,
  starring_csv,
  external_watch_url,
  theatrical_release_start,
  is_active
)
values (
  'erupcja',
  'Erupcja',
  2025,
  '1-2 Special',
  'https://images.squarespace-cdn.com/content/v1/674c8fb96ec79e2666c8e033/ee17fab6-6982-4ccf-8686-6ec878a956b3/ERUPJCA_POSTER_2x3_260127_FINAL.png',
  'While on vacation in Poland, Bethany (Charli xcx) breaks away from a romantic itinerary planned by her doting boyfriend, Rob (Will Madden), fearing that a marriage proposal is imminent. Reuniting instead with an old friend, Nel (Lena Góra), the two women rekindle a uniquely combustible chemistry over the course of a few days in a chaste but burning tryst predicated on sapphic synchronicity and a mutual penchant for poetry. However, Bethany''s impulsive behaviour is a star-crossed sonnet that is all too familiar for Nel, and as a lovelorn Rob wanders Warsaw in search of answers, the trio find themselves parsing the difference between destiny and serendipity.',
  71,
  'Pete Ohs',
  'Charli xcx, Lena Góra, Will Madden, Jeremy O. Harris',
  'https://erupcja.film/buy-tickets',
  '2026-04-17 00:00:00+00',
  true
)
on conflict (slug) do update set
  title = excluded.title,
  year = excluded.year,
  distributor = excluded.distributor,
  poster_url = excluded.poster_url,
  synopsis = excluded.synopsis,
  runtime_min = excluded.runtime_min,
  director = excluded.director,
  starring_csv = excluded.starring_csv,
  external_watch_url = excluded.external_watch_url,
  theatrical_release_start = excluded.theatrical_release_start,
  is_active = excluded.is_active,
  updated_at = now();

-- Reset offers for Erupcja to keep the seed idempotent.
delete from public.title_offers
where title_id = (select id from public.titles where slug = 'erupcja');

insert into public.title_offers (
  title_id,
  offer_type,
  provider,
  provider_url,
  region_code,
  is_active
)
select
  id,
  'theatrical',
  'In Theaters',
  'https://erupcja.film/buy-tickets',
  'US',
  true
from public.titles
where slug = 'erupcja';

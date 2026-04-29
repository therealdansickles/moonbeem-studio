-- Seed Erupcja fan edits (v9 spec, Session 1).
-- Idempotent: delete-then-insert by title_id (no unique constraint on embed_url).

delete from public.fan_edits
where title_id = (select id from public.titles where slug = 'erupcja');

insert into public.fan_edits (title_id, platform, embed_url, display_order, is_active, verification_status)
select id, 'instagram', 'https://www.instagram.com/reels/DXHbbZnCKTL/', 1, true, 'auto_verified' from public.titles where slug = 'erupcja'
union all select id, 'instagram', 'https://www.instagram.com/reels/DXCyMjykUjN/', 2, true, 'auto_verified' from public.titles where slug = 'erupcja'
union all select id, 'instagram', 'https://www.instagram.com/reels/DV2c-xJDDGc/', 3, true, 'auto_verified' from public.titles where slug = 'erupcja'
union all select id, 'instagram', 'https://www.instagram.com/reels/DW80wG4B-S3/', 4, true, 'auto_verified' from public.titles where slug = 'erupcja'
union all select id, 'tiktok',    'https://www.tiktok.com/embed/v2/7627616681170324758', 5, true, 'auto_verified' from public.titles where slug = 'erupcja'
union all select id, 'x',         'https://x.com/xcxsource/status/2037213168209191391', 6, true, 'auto_verified' from public.titles where slug = 'erupcja';

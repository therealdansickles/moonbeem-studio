-- Fix Instagram Reel URLs in fan_edits seed.
-- The /reels/ (plural) URL form is not normalized by react-social-media-embed's
-- InstagramEmbed component. Rewrite to /reel/ (singular) which is the canonical
-- form Instagram serves and the library's regex matches.
-- Both URL forms serve the same content — Instagram aliases /reels/{shortcode}/
-- to /reel/{shortcode}/ for end users.

update public.fan_edits
set embed_url = replace(embed_url, '/reels/', '/reel/')
where platform = 'instagram'
  and embed_url like '%/reels/%';

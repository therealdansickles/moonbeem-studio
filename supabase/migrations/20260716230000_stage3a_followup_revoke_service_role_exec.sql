-- Supabase default privileges grant EXECUTE on new public-schema functions to
-- service_role; 20260716200000's revoke listed public/anon/authenticated only.
revoke execute on function public.member_partner_ids() from service_role;

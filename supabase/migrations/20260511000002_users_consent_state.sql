-- Per-user consent state for the GDPR/CCPA cookie banner.
--
-- jsonb (not multiple boolean columns) so future categories — PostHog,
-- ad pixels, EU-specific stricter modes — can extend without
-- migrations. Shape today:
--   {
--     "analytics": boolean,         // GA4
--     "session_recording": boolean, // Microsoft Clarity
--     "updated_at": "ISO-8601",
--     "version": 1                  // banner-copy version; bump
--                                   // when materially changing what
--                                   // the user agreed to, to re-prompt
--   }
--
-- NULL = user has never interacted with the banner. Banner-shown logic
-- (and re-prompt on version bump) treats NULL identically to "no
-- decision recorded yet".
--
-- RLS inherits from the existing self-update policy on public.users
-- (20260501000002_users_self_update_rls.sql). Service-role bypasses
-- as usual. No new policy needed.

alter table public.users
  add column if not exists consent_state jsonb;

comment on column public.users.consent_state is
  'GDPR/CCPA cookie-banner consent. jsonb shape: { analytics, session_recording, updated_at, version }. NULL = no decision recorded.';

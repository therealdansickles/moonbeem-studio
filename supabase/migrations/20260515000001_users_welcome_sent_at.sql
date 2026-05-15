-- Adds users.welcome_sent_at to dedupe the welcome email across
-- subsequent magic-link sign-ins. The auth callback sets this once,
-- on first successful sign-in, via an UPDATE ... RETURNING that
-- atomically claims the send (only the request that flips NULL → now
-- actually sends).

alter table public.users
  add column if not exists welcome_sent_at timestamptz;

comment on column public.users.welcome_sent_at is
  'Timestamp the welcome email was sent. NULL = not yet sent. Auth callback uses UPDATE ... WHERE welcome_sent_at IS NULL ... RETURNING to atomically claim the send.';

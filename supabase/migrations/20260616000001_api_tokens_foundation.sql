-- Creator-scoped API tokens for external clients (e.g. the Premiere panel).
-- Additive: new table only, touches no existing object.
--
-- Security posture:
--  * token_hash = SHA-256 hex of the raw token. The raw token is generated
--    server-side, returned to the caller exactly once at creation, and NEVER
--    stored. Only the hash + a display prefix live here.
--  * RLS enabled with ZERO policies (modeled on creator_socials / partner_users):
--    no client JWT (anon or authenticated) can SELECT this table — token_hash is
--    unreachable by construction. All access goes through the service-role client
--    on the server.
--  * Content-only scopes, enforced by a CHECK constraint so a money scope cannot
--    be stored even if route validation were bypassed.

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  token_prefix text not null,
  token_hash text not null,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  -- Money-excluded by construction: scopes must be a non-empty subset of the
  -- content-only allowlist. A token can never carry a money/payout capability.
  constraint api_tokens_scopes_content_only check (
    cardinality(scopes) > 0
    and scopes <@ array['clip:download', 'fan_edit:submit']::text[]
  )
);

-- A SHA-256 hash is always present and must be globally unique (the validation
-- path looks tokens up by hash). token_hash is NOT NULL, so a plain unique index
-- is the correct form (the creator_socials partial-unique idiom is for a nullable
-- column).
create unique index api_tokens_token_hash_unique on public.api_tokens (token_hash);

-- Owner lookup for the list / revoke routes.
create index api_tokens_user_id_idx on public.api_tokens (user_id) where revoked_at is null;

-- RLS enabled, NO policies — service-role-only (creator_socials posture).
alter table public.api_tokens enable row level security;

comment on table public.api_tokens is
  'Creator-scoped API tokens for external clients (Premiere panel). token_hash = SHA-256 hex of the raw token; raw token shown once at creation, never stored. RLS enabled with zero policies (service-role only). Content-only scopes (CHECK-enforced); never authorizes money actions.';

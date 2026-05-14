-- Gating Phase 1: per-user lifetime usage counts for quota-tracked
-- capabilities (download_clip, download_still, ...).
--
-- One row per (user_id, capability). The server reads the count to
-- decide whether a tier's lifetime quota is reached, and increments
-- it when a capability is consumed. Writes go through the service
-- role only — quota tracking is server-side.
--
-- Note: this table tracks usage for the gating UI flow. It is not a
-- security boundary on its own — see the Phase 4 backlog (R2 private
-- files + signed URLs) for hard enforcement of asset downloads.

create table public.user_action_counts (
  user_id uuid not null references public.users(id) on delete cascade,
  capability text not null,
  count int not null default 0,
  first_used_at timestamptz,
  last_used_at timestamptz,
  primary key (user_id, capability)
);

create index idx_user_action_counts_user
  on public.user_action_counts (user_id);

alter table public.user_action_counts enable row level security;

-- Users can read their own counts (e.g. quota display).
create policy "users read own counts"
  on public.user_action_counts for select
  using (user_id = auth.uid());

-- Writes are server-side only (service role).
create policy "service role writes counts"
  on public.user_action_counts for all
  using (auth.jwt() ->> 'role' = 'service_role');

-- Atomic upsert-increment. A plain UPDATE ... count = count + 1
-- can't handle first use (no row yet); this INSERT ... ON CONFLICT
-- DO UPDATE is a single statement, so concurrent increments for the
-- same (user, capability) can't race.
create or replace function public.increment_user_action_count(
  p_user_id uuid,
  p_capability text
) returns void
language sql
as $$
  insert into public.user_action_counts
    (user_id, capability, count, first_used_at, last_used_at)
  values (p_user_id, p_capability, 1, now(), now())
  on conflict (user_id, capability) do update
    set count = user_action_counts.count + 1,
        last_used_at = now();
$$;

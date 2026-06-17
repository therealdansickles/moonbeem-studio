-- Follows — asymmetric creator-to-creator follow graph.
--
-- A follow is an edge (follower_creator_id -> target_creator_id). No
-- request/accept state: following is one-directional and immediate. Both
-- endpoints are creators.id; the target may be an unclaimed stub (you can
-- follow a creator that has no user yet), the follower must be a claimed
-- creator (the app resolves auth.uid() -> creators.id before any write).
--
-- NOT a money path: no apportionment, metering, or Stripe interaction.
--
-- RLS is the ENTIRE security story here. creators has wide-open base grants
-- (anon + authenticated hold INSERT/UPDATE/DELETE) and only an INSERT policy,
-- so we ship follows' complete policy set explicitly and never lean on an
-- implicit SELECT policy. The counter trigger is SECURITY DEFINER precisely
-- because creators has no UPDATE policy — an invoker-rights trigger would be
-- silently blocked from maintaining the counts.

-- ############################################################################
-- 1. Table
-- ############################################################################
create table if not exists public.follows (
  follower_creator_id uuid not null references public.creators(id) on delete cascade,
  target_creator_id   uuid not null references public.creators(id) on delete cascade,
  created_at          timestamptz not null default now(),
  primary key (follower_creator_id, target_creator_id),
  constraint follows_no_self_follow check (follower_creator_id <> target_creator_id)
);

-- PK (follower_creator_id, ...) already serves "who does X follow".
-- This index serves the reverse: "who follows X".
create index if not exists idx_follows_target on public.follows (target_creator_id);

-- ############################################################################
-- 2. RLS — public read, owner-only write through creators.user_id = auth.uid().
--    Write policy mirrors the canonical seven-table pattern (watched_titles et
--    al). The CHECK constraint blocks self-follow at the row level.
-- ############################################################################
alter table public.follows enable row level security;

drop policy if exists "follows owner write" on public.follows;
create policy "follows owner write"
  on public.follows for all
  using (exists (select 1 from public.creators c
                 where c.id = follows.follower_creator_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.creators c
                 where c.id = follows.follower_creator_id and c.user_id = auth.uid()));

drop policy if exists "follows public read" on public.follows;
create policy "follows public read"
  on public.follows for select
  using (true);

-- ############################################################################
-- 3. Denormalized counters on creators (mirrors user_lists.item_count
--    precedent — read on render, never count(*) on the hot path).
-- ############################################################################
alter table public.creators
  add column if not exists follower_count  integer not null default 0,
  add column if not exists following_count integer not null default 0;

-- ############################################################################
-- 4. Counter trigger. SECURITY DEFINER so the creators UPDATE is not blocked
--    by RLS (creators has no UPDATE policy). search_path pinned to public.
--    The follows base table is the ONLY write path, so this trigger is the
--    single source of counter truth. DELETE guards against negative drift.
-- ############################################################################
create or replace function public.sync_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.creators set following_count = following_count + 1
      where id = new.follower_creator_id;
    update public.creators set follower_count = follower_count + 1
      where id = new.target_creator_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.creators set following_count = greatest(following_count - 1, 0)
      where id = old.follower_creator_id;
    update public.creators set follower_count = greatest(follower_count - 1, 0)
      where id = old.target_creator_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_follow_counts on public.follows;
create trigger trg_sync_follow_counts
  after insert or delete on public.follows
  for each row execute function public.sync_follow_counts();

-- ############################################################################
-- 5. Backfill / reconciliation. On a greenfield follows table this sets every
--    creator to 0 (already the default). Kept as the canonical resync query:
--    re-run this block to repair counters if they ever drift.
-- ############################################################################
update public.creators c set
  following_count = (select count(*) from public.follows f where f.follower_creator_id = c.id),
  follower_count  = (select count(*) from public.follows f where f.target_creator_id   = c.id);

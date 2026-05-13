-- Email-queue atomic claim RPC + 'sending' status.
--
-- PostgREST can't express `attempts = attempts + 1` in a single
-- statement via the .update() builder, and we want the claim to be
-- atomic against concurrent drains (hot-path after() + cron sweep
-- can run within the same minute). So expose a small RPC that does
-- the UPDATE...RETURNING in one statement.
--
-- 'sending' is the in-flight status. Lifecycle:
--   pending → claim (sending, attempts++) → send → sent OR pending (retry) OR failed_permanently
--
-- If a drain crashes mid-row (cold-start, kill signal), rows stay
-- 'sending' permanently. Cron sweep includes a stale-claim reclaim:
-- any 'sending' row with updated_at older than 60s is also drained.
-- That's handled in the drainQueue() helper, not here.
--
-- Function is security-definer and intentionally NOT granted to
-- public or authenticated. Only service-role callers can invoke it
-- (which is what we want — only our server code should claim rows).

alter table public.email_queue
  drop constraint email_queue_status_check;

alter table public.email_queue
  add constraint email_queue_status_check
  check (status in ('pending', 'sending', 'sent', 'failed_permanently'));

create function public.claim_email_queue_rows(
  p_ids uuid[] default null,
  p_max_rows int default 100
)
returns table (
  id uuid,
  user_id uuid,
  title_id uuid,
  content_type text,
  content_ids uuid[],
  attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ids is not null and array_length(p_ids, 1) > 0 then
    return query
    update public.email_queue eq
    set status = 'sending',
        attempts = eq.attempts + 1,
        updated_at = now()
    where eq.id = any(p_ids)
      and eq.status = 'pending'
      and eq.next_retry_at <= now()
    returning eq.id, eq.user_id, eq.title_id,
              eq.content_type, eq.content_ids,
              eq.attempts;
  else
    return query
    update public.email_queue eq
    set status = 'sending',
        attempts = eq.attempts + 1,
        updated_at = now()
    where eq.id in (
      select inner_eq.id from public.email_queue inner_eq
      where inner_eq.status = 'pending'
        and inner_eq.next_retry_at <= now()
      order by inner_eq.next_retry_at asc
      limit greatest(1, least(p_max_rows, 500))
    )
    returning eq.id, eq.user_id, eq.title_id,
              eq.content_type, eq.content_ids,
              eq.attempts;
  end if;
end;
$$;

revoke execute on function public.claim_email_queue_rows(uuid[], int) from public;

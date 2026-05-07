-- Stage 4 (today): two-sided payout foundation. Side A wired up
-- (partner-funded creator payouts on a CPM model); Side B
-- schema-ready (direct transactions) but no logic today.
--
-- TABLES
--
-- partner_title_rates: per-(partner, title) CPM rate the partner
--   pays creators on view counts. Unique on (partner_id, title_id)
--   among non-deleted rows. Soft-delete via deleted_at lets a
--   partner pause a campaign without losing the rate history.
--
-- creator_earnings: ledger of what each creator has earned per
--   fan_edit per calculation date. One row per
--   (creator_id, fan_edit_id, calculation_date) — re-running the
--   daily calculation is idempotent. claimed=true once a verified
--   user owns the creator (either ingested as a non-stub creator,
--   or stub→user merge completed). Stub-attributed earnings sit
--   with claimed=false until verification flips them over (handled
--   in mark_social_verified_and_merge below).
--
-- transaction_attributions: schema-only today, populated when
--   Side B (direct transactions) ships in v1.5. Per-transaction
--   split: creator / Moonbeem / partner.
--
-- TITLES additions (Side B prep): transact_enabled toggle,
-- transact_price_cents, creator_share_pct, and the default
-- moonbeem_take_rate_pct = 0.15.
--
-- ANTI-FRAUD (NOT today): a follow-up should restrict CPM
-- payouts to view counts that have been stable for ≥7 days, so
-- the first day's burst doesn't accrue full earnings. v1 trusts
-- the upstream view counts at calculation time.

-- ---------------------------------------------------------------
-- partner_title_rates
-- ---------------------------------------------------------------

create table if not exists public.partner_title_rates (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  rate_cents_per_thousand integer not null
    check (rate_cents_per_thousand >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists partner_title_rates_active_unique
  on public.partner_title_rates (partner_id, title_id)
  where deleted_at is null;

create index if not exists idx_partner_title_rates_partner
  on public.partner_title_rates (partner_id) where deleted_at is null;

alter table public.partner_title_rates enable row level security;

-- ---------------------------------------------------------------
-- creator_earnings
-- ---------------------------------------------------------------

create table if not exists public.creator_earnings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  fan_edit_id uuid not null references public.fan_edits(id) on delete cascade,
  partner_id uuid not null references public.partners(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  views_at_calculation integer not null check (views_at_calculation >= 0),
  earnings_cents integer not null check (earnings_cents >= 0),
  calculation_date date not null,
  claimed boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists creator_earnings_per_day_unique
  on public.creator_earnings (creator_id, fan_edit_id, calculation_date);

create index if not exists idx_creator_earnings_creator
  on public.creator_earnings (creator_id);
create index if not exists idx_creator_earnings_partner
  on public.creator_earnings (partner_id);

alter table public.creator_earnings enable row level security;

-- ---------------------------------------------------------------
-- transaction_attributions (schema-only today)
-- ---------------------------------------------------------------

create table if not exists public.transaction_attributions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  title_id uuid not null references public.titles(id) on delete cascade,
  source_url text,
  transaction_amount_cents integer not null
    check (transaction_amount_cents >= 0),
  creator_earnings_cents integer not null check (creator_earnings_cents >= 0),
  moonbeem_earnings_cents integer not null check (moonbeem_earnings_cents >= 0),
  partner_earnings_cents integer not null check (partner_earnings_cents >= 0),
  created_at timestamptz not null default now(),
  paid_out_at timestamptz
);

alter table public.transaction_attributions enable row level security;

-- ---------------------------------------------------------------
-- titles: Side B prep
-- ---------------------------------------------------------------

alter table public.titles
  add column if not exists transact_enabled boolean not null default false,
  add column if not exists transact_price_cents integer,
  add column if not exists creator_share_pct numeric,
  add column if not exists moonbeem_take_rate_pct numeric default 0.15;

-- ---------------------------------------------------------------
-- mark_social_verified_and_merge: also migrate creator_earnings
-- ---------------------------------------------------------------
--
-- When a stub creator is merged into a user's verified creator, any
-- earnings that accrued on the stub need to follow. Re-create the
-- RPC to additionally reassign creator_earnings.creator_id and flip
-- claimed=true on those rows.

create or replace function public.mark_social_verified_and_merge(
  p_platform text,
  p_handle text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_creator_id uuid;
  v_normalized text;
  v_social_row public.creator_socials%rowtype;
  v_old_creator_id uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if p_platform not in ('tiktok', 'instagram', 'twitter', 'youtube') then
    raise exception 'invalid_platform';
  end if;
  v_normalized := lower(trim(p_handle));
  if v_normalized = '' or v_normalized !~ '^[a-z0-9_.]{1,30}$' then
    raise exception 'invalid_handle';
  end if;

  select id into v_user_creator_id
    from public.creators
    where user_id = v_user_id and deleted_at is null
    limit 1;
  if v_user_creator_id is null then
    raise exception 'no_creator';
  end if;

  select * into v_social_row
    from public.creator_socials
    where platform = p_platform
      and lower(handle) = v_normalized
    for update;
  if v_social_row.id is null then
    raise exception 'no_social_row';
  end if;
  if v_social_row.verification_code is null then
    raise exception 'no_active_verification';
  end if;
  if v_social_row.verification_started_at is null
     or v_social_row.verification_started_at < now() - interval '24 hours' then
    raise exception 'verification_expired';
  end if;

  v_old_creator_id := v_social_row.creator_id;

  update public.creator_socials
    set verified_at = now(),
        is_verified = true,
        verification_code = null,
        verification_started_at = null,
        creator_id = v_user_creator_id
    where id = v_social_row.id;

  if v_old_creator_id is not null and v_old_creator_id <> v_user_creator_id then
    -- Other socials on the stub move to the user.
    update public.creator_socials
      set creator_id = v_user_creator_id
      where creator_id = v_old_creator_id;

    -- Fan edits attribution moves.
    update public.fan_edits
      set creator_id = v_user_creator_id
      where creator_id = v_old_creator_id;

    -- NEW: any earnings that accumulated on the stub follow the
    -- merge. claimed flips true (a verified user now owns these).
    -- Conflicts on the unique (creator_id, fan_edit_id,
    -- calculation_date) index are theoretically possible if the
    -- user's creator and the stub both had a row for the same
    -- fan_edit on the same day — drop the dup with the smaller
    -- earnings_cents and keep the larger.
    update public.creator_earnings
      set creator_id = v_user_creator_id,
          claimed = true
      where creator_id = v_old_creator_id
        and not exists (
          select 1 from public.creator_earnings dup
          where dup.creator_id = v_user_creator_id
            and dup.fan_edit_id = creator_earnings.fan_edit_id
            and dup.calculation_date = creator_earnings.calculation_date
        );
    delete from public.creator_earnings
      where creator_id = v_old_creator_id;

    -- Soft-delete the stub.
    update public.creators
      set deleted_at = now()
      where id = v_old_creator_id and deleted_at is null;
  end if;

  return v_user_creator_id;
end;
$$;

revoke execute on function public.mark_social_verified_and_merge(text, text) from public;
grant execute on function public.mark_social_verified_and_merge(text, text) to authenticated;

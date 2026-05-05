-- Post-bridge schema extensions across multiple tables.
--
-- None of these columns are populated by current code paths. Adding
-- them now is cheap insurance — every column we don't add today
-- becomes a future migration against more populated tables. Six
-- concern areas, grouped below.
--
-- 1. Letterboxd account import readiness on users
--    Surfaces the planned "import your Letterboxd account" onboarding
--    flow. Captures the raw username and the import timestamp so we
--    can a) detect re-imports for diff handling and b) show "imported
--    from Letterboxd on <date>" in the user's profile.
--
-- 2. Soft delete on heavily FK'd tables (titles, creators)
--    Hard deletes against titles or creators would cascade through
--    title_offers, fan_edits, affiliate_links, external_clicks,
--    title_requests, creator_slate, and notification_log. Soft
--    delete via deleted_at preserves history while letting the UI
--    treat the row as gone. Partial indexes on (id) / (handle)
--    where deleted_at is null give us cheap "active rows only"
--    lookups without scanning soft-deleted history.
--
-- 3. Franchise / universe grouping + locale metadata on titles
--    canonical_id is a self-referencing FK pointing the per-region
--    or per-cut variants of a title at one canonical row (e.g. the
--    UK theatrical edit and the US streaming cut both point at the
--    canonical theatrical release). primary_language and
--    country_codes are the language/origin metadata our /changes
--    pipeline already harvests but doesn't fully store yet.
--
-- 4. Multi-kind creator profiles
--    The 'creators' table currently only models fan-editors
--    implicitly. profile_kind opens the door to filmmakers (claiming
--    their own films), distributors, critics, programmers, and
--    institutions on the same surface. Default 'fan_editor' so
--    existing reasoning is unchanged.
--
-- 5. Remix attribution chain on fan_edits
--    is_remix_of points at a parent fan_edit when the new edit was
--    inspired by / built on / re-cut from another. Self-FK with
--    ON DELETE SET NULL: deleting the parent leaves the child
--    standing without breaking the row.
--
-- 6. Lightweight audit columns
--    created_by on titles / fan_edits / clips / stills lets us track
--    who minted each row. Currently zero rows have this populated;
--    going forward the relevant insert paths can set it. Existing
--    rows have NULL (unknown / pre-instrumentation), which is fine.
--
-- All FKs use ON DELETE SET NULL where applicable so user/title
-- deletion never cascades into content rows.

-- 1. Letterboxd account import readiness ----------------------------
alter table public.users
  add column if not exists letterboxd_username text,
  add column if not exists imported_from_letterboxd_at timestamptz;

-- 2. Soft delete -----------------------------------------------------
alter table public.titles
  add column if not exists deleted_at timestamptz;
alter table public.creators
  add column if not exists deleted_at timestamptz;

create index if not exists idx_titles_active
  on public.titles (id) where deleted_at is null;
create index if not exists idx_creators_active
  on public.creators (moonbeem_handle) where deleted_at is null;

-- 3. Franchise / universe grouping + locale metadata ----------------
alter table public.titles
  add column if not exists canonical_id uuid
    references public.titles(id) on delete set null,
  add column if not exists primary_language text,
  add column if not exists country_codes text[];

create index if not exists idx_titles_canonical
  on public.titles (canonical_id) where canonical_id is not null;

-- 4. Multi-kind creator profiles ------------------------------------
alter table public.creators
  add column if not exists profile_kind text not null default 'fan_editor'
    check (profile_kind in ('fan_editor', 'filmmaker', 'distributor', 'critic', 'programmer', 'institution'));

-- 5. Remix attribution chain ----------------------------------------
alter table public.fan_edits
  add column if not exists is_remix_of uuid
    references public.fan_edits(id) on delete set null;

create index if not exists idx_fan_edits_remix_chain
  on public.fan_edits (is_remix_of) where is_remix_of is not null;

-- 6. Lightweight audit columns --------------------------------------
alter table public.titles
  add column if not exists created_by uuid
    references public.users(id) on delete set null;
alter table public.fan_edits
  add column if not exists created_by uuid
    references public.users(id) on delete set null;
alter table public.clips
  add column if not exists created_by uuid
    references public.users(id) on delete set null;
alter table public.stills
  add column if not exists created_by uuid
    references public.users(id) on delete set null;

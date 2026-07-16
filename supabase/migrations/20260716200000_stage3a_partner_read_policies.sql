-- Stage 3A: partner-member READ policies — additive defense-in-depth.
--
-- ── DOCTRINE (non-negotiable, per Dan 2026-07-16) ────────────────────────────
-- STRICTLY ADDITIVE. This migration contains ZERO drop policy, ZERO alter
-- policy, and ZERO grant changes on any EXISTING object. Every policy already
-- in place — titles "titles are publicly readable", fan_edits public-active,
-- clips/stills public-on-active + super-admin ALL, title_requests
-- insert/self_read/super-admin, users self read/update, title_offers public,
-- and the public_creators / public_profiles view grants — stays byte-identical.
-- RLS policies are PERMISSIVE (OR-combined), so adding partner_member_read
-- can only WIDEN what an authenticated caller sees, never narrow it; anon is
-- untouched (every new policy is TO authenticated).
--
-- Today every partner-dashboard read runs on the service-role client (RLS-
-- immune; tenancy is app-level via the titles.partner_id derivation at
-- p/[slug]/dashboard/page.tsx:1345-1349). These policies change NO current
-- behavior on that surface — they make a future session-client dashboard
-- possible and put a database floor under the app-level tenancy.
--
-- ── EXCLUDED, DENY-ALL STAYS (write NO policies here, ever, without a money-
-- rail session): creator_earnings, partner_credits, campaign_funding,
-- partner_payout_accounts, transaction_settlements, transaction_attributions,
-- campaign_ledger, campaign_payouts, campaign_metering_deltas,
-- campaign_metering_runs, withdrawals, tips, entitlements — and every other
-- money table. Their RLS stays enabled-with-zero-policies.
--
-- ── THE ONE MEMBERSHIP HELPER ────────────────────────────────────────────────
-- member_partner_ids() is the ONLY place any policy consults partner_users.
-- SECURITY DEFINER so the policies on OTHER tables never need partner_users
-- read rights (and so partner_users' own self-read policy below cannot
-- recurse); STABLE so the planner evaluates it once per statement (hashed
-- subplan / initplan, not per row); search_path pinned per the house rule for
-- every definer function. auth.uid() is NULL for anon -> empty set -> every
-- partner_member_read policy evaluates false. Rides
-- idx_partner_users_user_id (user_id) WHERE deleted_at IS NULL — an exact
-- match for this predicate (verified in pg_indexes 2026-07-16).
create function public.member_partner_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select partner_id
  from public.partner_users
  where user_id = auth.uid()
    and deleted_at is null
$$;

-- EXECUTE-grant decisions (quoted per the pass spec):
--   1. revoke from public/anon/authenticated first — Supabase grants EXECUTE
--      to PUBLIC by default on public-schema functions (the exact footgun
--      20260706150000 closed on the creator finalize RPC).
--   2. grant back to authenticated ONLY: the new policies are TO
--      authenticated, and the querying role must be able to execute a
--      function its policy predicate calls. anon never evaluates these
--      policies, so it gets no grant — if a future policy mistakenly targeted
--      anon, the missing EXECUTE fails loudly instead of leaking.
--   3. service_role gets no grant: it bypasses RLS entirely and no code path
--      calls this function directly.
--   The function is safe for any authenticated caller regardless: it returns
--   only the CALLER's own memberships (auth.uid()-bound), nothing else.
revoke all on function public.member_partner_ids() from public, anon, authenticated;
grant execute on function public.member_partner_ids() to authenticated;

-- ── POLICIES ─────────────────────────────────────────────────────────────────
-- All 13: SELECT only, TO authenticated, named partner_member_read.
-- A note on the hop policies (fan_edits, fan_edit_events, external_clicks,
-- view_tracking_snapshots, title_requests, clips, stills, campaign_titles):
-- their EXISTS subqueries run under the CALLER's RLS on the probed table.
-- That is safe and intentional here:
--   - probes into titles see every row today ("titles are publicly readable"
--     USING (true)), and a partner's own titles stay visible via the titles
--     policy below even if the public one is ever tightened;
--   - probes into fan_edits/campaigns see the caller's partner rows via the
--     sibling policies in THIS migration, so the chains are self-sufficient;
--   - fan_edit_events/view_tracking_snapshots on a SOFT-DELETED partner
--     fan_edit stay hidden (the fan_edits policy requires deleted_at IS
--     NULL) — matching the dashboard's manual deleted_at discipline.
-- No cycles: nothing consults partner_users except the DEFINER helper.

-- partners: the tenant root. Attach point = id (PK). Per-row probes ride
-- partners_pkey; the member list is a one-time initplan.
create policy partner_member_read on public.partners
  for select to authenticated
  using (id in (select public.member_partner_ids()));

-- partner_users: SELF-READ ONLY, by spec — a member sees their own live
-- membership rows, not their teammates' (the roster surface is an admin
-- feature served by the SECURITY DEFINER list_partner_members RPC).
-- Deliberately does NOT use the helper: the predicate is self-contained,
-- auth.uid()-only (house idiom, matches every existing self policy), and
-- cannot recurse. Rides idx_partner_users_user_id (user_id) WHERE
-- deleted_at IS NULL — exact predicate match.
create policy partner_member_read on public.partner_users
  for select to authenticated
  using (user_id = auth.uid() and deleted_at is null);

-- titles: direct attach on titles.partner_id (nullable — catalog titles with
-- no partner have NULL, which can never match a member id). Redundant TODAY
-- under "titles are publicly readable" USING (true); shipped anyway so a
-- partner's catalog reads survive any future tightening of the public
-- policy. Member-direction scans ride idx_titles_partner_id (partner_id)
-- WHERE partner_id IS NOT NULL (usable: partner_id = <uuid> implies NOT
-- NULL); row probes ride titles_pkey.
create policy partner_member_read on public.titles
  for select to authenticated
  using (partner_id in (select public.member_partner_ids()));

-- fan_edits: 1 hop via titles. deleted_at IS NULL is part of the policy (per
-- spec): partner members get live rows in EVERY status (pending/rejected —
-- wider than the public active+verified policy, which is the point for a
-- submissions inbox), but never soft-deleted rows. Per-row probes ride
-- titles_pkey; app queries shaped .in(title_id, ...) ride idx_fan_edits_
-- title_id / idx_fan_edits_title_active_order.
create policy partner_member_read on public.fan_edits
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1
      from public.titles t
      where t.id = fan_edits.title_id
        and t.partner_id in (select public.member_partner_ids())
    )
  );

-- fan_edit_events: 2 hops (fan_edit_id -> fan_edits.title_id -> titles.
-- partner_id). The fan_edits probe is RLS-gated for the caller, so events on
-- another partner's rows — or on soft-deleted rows — are invisible by
-- construction. Per-row probes ride fan_edits_pkey + titles_pkey; app
-- queries shaped .in(fan_edit_id, ...) ride
-- idx_fan_edit_events_fan_edit_id_created (leading column).
create policy partner_member_read on public.fan_edit_events
  for select to authenticated
  using (
    exists (
      select 1
      from public.fan_edits fe
      where fe.id = fan_edit_events.fan_edit_id
        and exists (
          select 1
          from public.titles t
          where t.id = fe.title_id
            and t.partner_id in (select public.member_partner_ids())
        )
    )
  );

-- external_clicks: 1 hop via titles. title_id is nullable (offer/affiliate
-- clicks without title attribution): NULL rows stay hidden from partners —
-- correct, they are not attributable to a partner's catalog. Probes ride
-- titles_pkey; app queries ride idx_external_clicks_title_clicked (leading
-- title_id).
create policy partner_member_read on public.external_clicks
  for select to authenticated
  using (
    exists (
      select 1
      from public.titles t
      where t.id = external_clicks.title_id
        and t.partner_id in (select public.member_partner_ids())
    )
  );

-- view_tracking_snapshots: 2 hops via fan_edits, same shape and rationale as
-- fan_edit_events. Probes ride fan_edits_pkey + titles_pkey; app queries
-- shaped .in(fan_edit_id, ...) ride idx_vts_fan_edit_captured.
create policy partner_member_read on public.view_tracking_snapshots
  for select to authenticated
  using (
    exists (
      select 1
      from public.fan_edits fe
      where fe.id = view_tracking_snapshots.fan_edit_id
        and exists (
          select 1
          from public.titles t
          where t.id = fe.title_id
            and t.partner_id in (select public.member_partner_ids())
        )
    )
  );

-- title_requests: 1 hop via titles. Additive alongside the existing anon/auth
-- INSERT, self_read, and super-admin SELECT policies (all untouched). Probes
-- ride titles_pkey; the dashboard's open-requests shape rides
-- idx_title_requests_open (title_id) WHERE fulfilled_at IS NULL.
create policy partner_member_read on public.title_requests
  for select to authenticated
  using (
    exists (
      select 1
      from public.titles t
      where t.id = title_requests.title_id
        and t.partner_id in (select public.member_partner_ids())
    )
  );

-- partner_title_rates: direct attach on partner_id. INDEX FLAG (decision
-- quoted): both partner_id indexes are PARTIAL (WHERE deleted_at IS NULL) and
-- this policy carries no deleted_at clause, so a policy-driven scan that
-- includes soft-deleted rows has no covering index. NO new index proposed:
-- the table is tens of rows (8 partners x small catalogs) where a seq scan
-- beats any index; revisit (non-partial btree on partner_id) only if
-- soft-deleted rate rows ever reach the thousands.
create policy partner_member_read on public.partner_title_rates
  for select to authenticated
  using (partner_id in (select public.member_partner_ids()));

-- clips: 1 hop via titles. Additive alongside the public-on-active-titles and
-- super-admin policies (untouched). Note the deliberate asymmetry vs the
-- public policy: no deleted_at clause here (per spec) — a partner member can
-- see their own soft-deleted clips, which a management surface wants; the
-- public policy still hides them from everyone else. Probes ride titles_pkey;
-- app queries ride idx_clips_title_order (leading title_id).
create policy partner_member_read on public.clips
  for select to authenticated
  using (
    exists (
      select 1
      from public.titles t
      where t.id = clips.title_id
        and t.partner_id in (select public.member_partner_ids())
    )
  );

-- stills: same shape, same rationale, same index story as clips
-- (idx_stills_title_order leading title_id).
create policy partner_member_read on public.stills
  for select to authenticated
  using (
    exists (
      select 1
      from public.titles t
      where t.id = stills.title_id
        and t.partner_id in (select public.member_partner_ids())
    )
  );

-- campaigns: direct attach on partner_id (NOT NULL). First-ever policy on
-- this table (deny-all otherwise, and deny-all it stays for non-members —
-- the public /t/[slug]/campaign surface reads via service role on purpose).
-- Member-direction scans ride idx_campaigns_partner_id; probes ride
-- campaigns_pkey.
create policy partner_member_read on public.campaigns
  for select to authenticated
  using (partner_id in (select public.member_partner_ids()));

-- campaign_titles: 1 hop via campaigns (campaign_id -> campaigns.partner_id).
-- The campaigns probe is RLS-gated for the caller and campaigns has only the
-- sibling policy above, so non-members resolve to zero rows. Probes ride
-- campaigns_pkey; member-direction scans ride
-- campaign_titles_campaign_id_title_id_key (leading campaign_id).
create policy partner_member_read on public.campaign_titles
  for select to authenticated
  using (
    exists (
      select 1
      from public.campaigns c
      where c.id = campaign_titles.campaign_id
        and c.partner_id in (select public.member_partner_ids())
    )
  );

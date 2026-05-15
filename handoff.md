# HANDOFF — 2026-05-14 (Thursday)

Session length: ~12 hours
Total commits: 33+
Strategic deliverables: Three coherent arcs (compliance, onboarding/curation, gating)

---

## Morning arc: compliance (commits e65be44 → 329ad67)

- Privacy policy refined (function-grouped processor categories, GDPR Art. 13/14 compliant, privacy@moonbeem.xyz mailto added)
- Site footer added (src/components/Footer.tsx server component) with brand wordmark, tagline, Privacy/Terms/Contact links
- Entity name corrected: "Moonbeem Studio Inc." → "Moonbeem, Inc." across all surfaces
- DMCA federal registration completed at dmca.copyright.gov
  - Number: DMCA-1072736 (Active)
  - Service Provider: Moonbeem, Inc., 255 Eastern Parkway, Brooklyn, NY 11238
  - Designated Agent: Daniel Sickles, dan@dansickles.com
  - Alternate names registered: Moonbeem, Moonbeem Inc, Moonbeem Studio, Moonbeem Studio Inc, moonbeem.studio, moonbeem.xyz
- Terms of Service shipped (/terms-of-service)
  - 17 sections, editorial brand voice with "Plain summary:" lead-ins
  - Five locked policy decisions: 13+ to use / 18+ for payouts, Delaware governing law, mandatory arbitration with IP + small claims carve-outs, Standard content license scope, $100 liability cap
- /me/privacy-settings page added (analytics + session recording toggles, noindex, anonymous-accessible)

## Onboarding + curation arc (commits 843e952 → c165a3b)

- /me redesigned with section order: Your fan edits → Your top 12 → Verified accounts → Earnings → Recent activity
- WelcomeBanner component built (welcome onboarding banner with two CTAs, auto-dismiss logic, dismissal endpoint)
- /browse → / redirect (308 permanent)
- /me/top-12 builder built end-to-end:
  - Dedicated route for Top 12 curation
  - Drag-and-drop reorder via @dnd-kit (verticalListSortingStrategy)
  - Real-time search with 300ms debounce
  - Discovery surface: Featured → AFI Top 100 → Top Rated Series → Recently added
  - "Done for now →" gated at 3+ picks
- Critical drag bug diagnosed via live DB probe and fixed:
  - user_top_titles CHECK constraint dropped <= 12 enforcement (kept >= 1 + UNIQUE)
  - Reorder operations now use temp positions during shuffle without constraint violation
  - <= 12 enforced at API layer only
- Three-surface Top 12 architecture locked:
  - /me/top-12: canonical builder
  - /me/edit: read-only display + "Manage" link
  - /c/[handle]: pure public viewing surface
- Curated lists schema (curated_lists + curated_list_titles tables, RLS-policied, super-admin write)
  - Migration 20260514000004
- AFI Top 100 seeded (full 100, after backfill of 6 missing titles)
  - Migration 20260514000005 (initial 94/100 matches)
  - Migration 20260514000007 (backfill of 6 gaps via title-variation and year-tolerance matching)
- Top Rated Series seeded (50/50 matches)
  - Migration 20260514000005 (initial)
  - Migration 20260514000006 (rename from "Greatest TV Shows of All Time")
- Carousel architecture:
  - Click-and-drag horizontal scroll via existing useDragScroll hook
  - Poster image drag lock (draggable={false} + pointer-events-none)
  - "View all" links on all four carousels (Featured, AFI, Top Rated Series, Recently added)
- /lists/[slug] dedicated list pages built
  - Public route, server-resolves by slug
  - Full grid view (2 cols mobile → 6 desktop)
  - Empty position placeholders for gapped positions (e.g., Casablanca #3 pre-backfill)
  - + Add works for authenticated users, sign-in prompt for anonymous
  - Auth-aware "Back" link
- /lists/featured and /lists/recently-added static routes added
  - Recently-added capped at 200 (future-proofing — current public catalog is small)
- "Browse Moonbeem" CTA relocated from inline-under-Verify-handle to standalone block between Top 12 and Verified accounts
  - Visibility logic: shown when top12Count >= 1 AND verifiedSocials.length === 0
- "Keep exploring" lead-in copy on the Browse Moonbeem block
- Color fix: Browse Moonbeem now uses moonbeem-violet (#7c3aed) instead of moonbeem-pink (which stays on "Verify a handle →" as primary)

CATALOG LESSON BANKED: When matching titles against the 1.4M-row catalog, always use the search_titles RPC. Raw .ilike() against the titles table does a full table scan and times out on the pooler. This was diagnosed today when initial AFI seeding returned 0/150 matches.

## Gating arc: Phases 1-2 + UX hotfix (commits 1805b5e → 8664910)

### Gating Phase 1 — Three-tier infrastructure + clip downloads gated

- user_action_counts table for lifetime quota tracking
  - Migration 20260514000008
  - PK on (user_id, capability), RLS for user-read-own + service-write
  - Atomic increment_user_action_count RPC
- src/lib/gating/ utilities:
  - types.ts (Tier, Capability, GateConfig, CanPerformResult)
  - gate-map.ts (single source of truth for capability/tier matrix)
  - get-user-tier.ts (server-side, returns anonymous/signed_in/verified based on verified social handle count)
  - can-perform.ts (pure function, super-admin bypass via early return, quota-aware)
  - usage-counts.ts (server-side getUsageCount + incrementUsageCount)
- GateModal component (src/components/gating/GateModal.tsx)
  - Three variants: auth_required, verification_required, limit_reached
  - Reusable, dismissible (ESC, backdrop click, "Maybe later")
  - Editorial brand voice (no exclamation marks, no em dashes)
- Clip downloads gated end-to-end:
  - /api/clips/[id]/download route created (proxies bytes through gate check)
  - VideosTab converted to client component with gated fetch flow
  - Quota indicator: "Download (N left)" appears after first use
  - Super-admin coerced to "verified" for UI; server still bypasses
- Intent preservation via URL-based redirects:
  - GateModal preserves currentPath as return_to
  - /login?redirect_to=[path] for auth_required
  - /me/edit?return_to=[path] for verification_required and limit_reached
  - Same-origin validation on return_to (open-redirect protection)
- VerifySocialsCard updated with onVerified callback (distinct from visibility toggle onChange) — triggers return_to redirect on actual verification
- SOFT GATE FRAMING: Documented in commit messages and inline comments. R2 file URLs remain publicly accessible (player needs them). Phase 4 banks hardening (private files + signed URLs).

### Gating Phase 2 — Stills + Top 12 formalization + user_events ledger

- user_events table for full per-action ledger
  - Migration 20260514000009
  - Schema: id, user_id, event_type, resource_type, resource_id, title_id, tier_at_event, metadata jsonb, created_at
  - Indexes: user+time, resource (type+id), title_id, event_type+time
  - RLS: users read own, service role writes
- logUserEvent utility (src/lib/events/log-event.ts) with fail-soft behavior
- Still downloads gated end-to-end:
  - /api/stills/[id]/download route created (parallel to clips)
  - StillsTab lightbox toolbar with quota indicator + GateModal-replaced inline CTA (see Hotfix below)
  - Limit: 10 lifetime per signed-in non-super-admin user
- Top 12 save formalization:
  - /api/profile/top-titles/{add,remove,reorder} now use canPerform pattern
  - Returns 403 with reason instead of 401 redirect
  - save_to_top12 and remove_from_top12 events logged (reorder gated but not logged — internal organization, not signal)
- Event logging on:
  - download_clip (Phase 1 retroactive)
  - download_still
  - save_to_top12
  - remove_from_top12
  - verify_social (with platform + handle metadata)
- Super-admin split behavior:
  - user_action_counts: super-admin EXCLUDED (no quota tracking)
  - user_events: super-admin INCLUDED (full ledger)
  - canPerform: super-admin ALWAYS allowed (bypass)
- Count semantics documented inline: lifetime usage for all signed-in non-super-admin users (verified users continue incrementing for analytics; gate doesn't restrict based on count for verified tier)

### Stills lightbox UX hotfix (commit 8664910)

- Phase 2 verification surfaced UX gap: GateModal hidden behind YARL lightbox z-index when triggered from in-lightbox download attempt
- Fix: StillsTab no longer triggers GateModal — replaces toolbar Download button with inline navigation CTA on 403
  - auth_required: "Sign in to download" → /login?redirect_to=[path]
  - limit_reached: "Verify to download" → /me/edit?return_to=[path]
  - verification_required: "Verify a handle" → /me/edit?return_to=[path]
- <Link> styled as YARL toolbar button — navigation unmounts lightbox naturally
- Gate-state lifetime:
  - limit_reached / verification_required: persist across lightbox open/close
  - auth_required: resets on close
- GateModal still used by VideosTab for clips (no lightbox = no z-index conflict)
- Decision made: GateModal completely dropped from StillsTab (no fallback after lightbox close — inline CTA fully covers all three reasons)

## Decisions locked today

- Three-tier gating model: anonymous / signed_in / verified
- Quota system: lifetime per user, no reset on un-verification
- Modal pattern: dismissible (not coercive)
- Intent preservation: URL-based (return_to=) — same-origin validated
- Super-admin bypass: via canPerform early return + UI tier coercion
- Soft gate on file URLs is intentional for v1 (Phase 4 banks hardening)
- Count semantics: lifetime usage for all signed-in users, verified included for analytics
- Stills download is lightbox-only (no per-card button)
- Network analytics surfaces deferred (data foundation built today, queryable via SQL)
- Top 12 architecture: single canonical builder, multiple display surfaces
- Curated lists are first-class content (not just builder helpers)

## Infrastructure state end of day

- Supabase project: qdngcwhubzomwymhaiel (production)
- Compute tier: Medium (upgraded from Micro this evening, $60/mo)
- All migrations 20260514000001-000009 applied + verified on prod
- tsc + next build clean across all commits
- Vercel deployments successful for all pushes
- DMCA registration active (DMCA-1072736)
- Domain: moonbeem.studio (production), local /Users/dansickles/moonbeem-studio
- GitHub: therealdansickles/moonbeem-studio

## Network analytics queries now possible

Verified queryable via SQL (Test 8 + Test 9 in Phase 2 verification):

Top titles across network:
```sql
SELECT t.title, t.year, COUNT(DISTINCT utt.user_id) as users_count
FROM user_top_titles utt
JOIN titles t ON t.id = utt.title_id
GROUP BY t.id, t.title, t.year
ORDER BY users_count DESC
LIMIT 50;
```

Event counts by type:
```sql
SELECT event_type, COUNT(*) FROM user_events GROUP BY event_type;
```

Per-user event ledger:
```sql
SELECT event_type, resource_id, title_id, created_at
FROM user_events
WHERE user_id = '<uuid>'
ORDER BY created_at DESC;
```

These foundations enable: partner dashboards, super-creator identification, content performance tracking, Erupcja-style case studies with real numbers, distribution prioritization signal, taste profiling by partner.

## Followup queue (updated)

High-leverage next-work candidates:

1. Erupcja case study documentation
   - Highest-impact near-term deliverable for bridge round (per memory)
   - Now has real data foundation (user_events ledger)
   - Needs: campaign narrative + view numbers + click-through metrics + verification conversion rate

2. Gating Phase 3
   - Upload fan edit (when feature ships)
   - Earnings dashboard (when feature ships)
   - Download-all-zip (when feature ships)
   - Integrates with existing gateMap (just new capabilities)

3. Gating Phase 4: R2 file URL hardening
   - Make R2 clips private; generate signed URLs on demand
   - Estimated 4-6+ hours, possibly more
   - Required before any partner conversation focused on download security

4. Network analytics surfaces
   - Super-admin /admin/analytics page (~6-8h)
   - Partner-facing dashboards (~12-15h, requires multi-tenant RLS)
   - Use cases: top titles, top creators, downloads by title/user, taste profiling

5. Real /browse page build
   - Currently 308 redirect to /
   - Real page needs design and curation

6. Remaining partner catalog seeding at .studio
   - Magnolia, Oscilloscope, Roadside Attractions, Topic Studios, Utopia, MoMA Film, Harpoon
   - Exist operationally but not seeded into .studio DB

7. Stripe Connect live-mode flip
   - Currently sandbox; production checklist needed

8. Production hardening (banked from earlier sessions):
   - Sentry / production logging (~4-6h)
   - CSP allowlist build (~1-2h)
   - Remaining 17 client fetcher 429 handling (~1h)
   - Clip thumbnails proper ffmpeg pipeline (replacing #t=0.1 hack)

9. purchase_rental / rental_click event types
   - Deferred: no on-platform purchase flow currently exists
   - Wire when Stripe Connect on-platform checkout ships, or when /go/ click tracking is mirrored to user_events

10. Column name decision: user_action_counts → user_capability_usage
    - Bikeshed-bank; rename only if semantic confusion surfaces

## Next session context

Tomorrow opens with substantial banked work. No critical bugs blocking. Gating system end-to-end functional and verified. Erupcja activation flow complete: fan clicks Charli tweet → browses freely → downloads → gated 4th clip → verifies → unlimited + earning + attribution unlocked.

Strategic priorities for next session selection:
- Bridge round leverage: Erupcja case study + investor outreach prep
- Engineering momentum: Phase 3 / Phase 4 gating
- Production hardening: Sentry, CSP, logging
- Partner catalog seeding (operational debt)

Pick based on energy + strategic moment, not feature-list order.

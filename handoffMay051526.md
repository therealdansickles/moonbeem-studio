# MOONBEEM STUDIO — END OF DAY HANDOFF (2026-05-15)

═══════════════════════════════════════════════════════════════
WHO I AM
═══════════════════════════════════════════════════════════════

Dan Sickles, CEO Moonbeem Inc. — see Claude's memory for full company 
context. Working pattern: I orchestrate between this Claude instance 
(strategy/prompts/review) and Claude Code (local execution on 
/Users/dansickles/moonbeem-studio). I paste Claude Code's reports for 
pressure-testing before greenlighting next steps.

Communication style enforced: no em dashes, no exclamation marks 
(except in warm openings), no "also" as transition, no "it's not X 
it's Y" constructions, short declarative sentences, "Hey" openers, 
"More soon, Dan" sign-offs. Brand voice: editorial, sophisticated, 
understated.

═══════════════════════════════════════════════════════════════
WHAT WE SHIPPED MAY 15 — COMPLETE
═══════════════════════════════════════════════════════════════

Roughly 13 sub-blocks of production code, all deployed and verified 
on prod.

BLOCK 1 (~3 hours, morning): Email infrastructure
- Supabase Auth SMTP via Resend, sender hello@moonbeem.studio
- Five branded transactional templates: welcome, magic link, 
  fan_edit_pending, fan_edit_approved, fan_edit_rejected, 
  title_request_alert, request_fulfilled
- Brand voice: "Hey Beemer," / "Team Moonbeem" / violet wordmark
- Welcome email idempotent via atomic UPDATE on users.welcome_sent_at
- DNS migrated to Cloudflare; hello@moonbeem.studio routes to my real 
  inbox
- Multi-file batching fix on /api/admin/clips and /api/admin/stills

BLOCK 2 family (eight sub-blocks): Admin fan_edit import
- 2.0: Single URL + bulk CSV import surfaces at /admin/fan-edits/new 
  and /admin/fan-edits/upload
- 2.1: Creator resolver via creator_socials → creators with manual 
  override picker; R2 thumbnail proxy for single flow; IG post-type 
  UX hint
- 2.2: Recon confirming creators-vs-users architecture is sound (113 
  rows, 105 stubs). Memory's "creators table empty" note was stale.
- 2.3: getFanEditsForCreator helper. Fan_edits render on /me and 
  /c/[handle] via ProfileFanEditCard component.
- 2.4: Recon on stub claim flow — confirmed claim_handle Branch 2 + 
  mark_social_verified_and_merge handle stub-link and handle-
  mismatch correctly. No refactor needed.
- 2.5: "Edits to claim" surfacing on /me with platform-scoped 
  verified_social matching and Stage 2C URL-param prefill flow
- 2.6: R2 thumbnail proxy for BULK path; fulfillment scoped to 
  request_type='fan_edits' (clips_and_stills no longer cross-
  contaminated)
- 2.7: TikTok short-link resolver (tiktok.com/t/, vm., vt.); empty 
  EnsembleData response handling (no more ghost rows); IG URL 
  canonicalization (/reel/, /reels/, /p/ → canonical /reel/)

BLOCK 3 + 3.1 + 3.2: User-side fan edit submission
- 3.0: /c/[handle]/upload page with single-URL + multi-URL tabs; 
  /api/me/fan-edits/* routes; three entry points (own profile, 
  /t/[slug] inline, /me empty state); /admin/fan-edits/queue 
  approval surface; /me pending + rejected sections; email wiring
- Migration: verification_status CHECK extended to 'auto_verified' | 
  'needs_review' | 'pending' | 'approved' | 'rejected'; new columns 
  rejection_reason + created_by_user_id
- 3.1: CTA visibility upgrade above Top 12; admin nav surfacing 
  "Review queue (N)"; [test] subject prefix removed; sender display 
  name "Moonbeem"; rejection email copy aligned with /me UI
- 3.2: Verification banner on /me/edit when bounced from upload flow

═══════════════════════════════════════════════════════════════
PRODUCTION DATA STATE
═══════════════════════════════════════════════════════════════

- 113 creators (105 stubs, 8 claimed)
- 265+ fan_edits across all platforms (252 attributed to stubs 
  awaiting claim)
- Bulk smoke test added 10 fan_edits to Erupcja with ~400K combined 
  platform views including Charli XCX's tweet at 185K
- New stub creators created today: charli_xcx (Twitter), 
  leolovescharli (TikTok), duolingopolska (TikTok), 
  imthat.girlfriend (IG), velvet.spoon (IG), polishculturalinstituteny 
  (IG), justlikewerefamous (IG), among others

═══════════════════════════════════════════════════════════════
BANKED — NOT BLOCKING
═══════════════════════════════════════════════════════════════

DATA HYGIENE:
- DW_-eNWDevP cleanup: row 0552cbe6-d85c-4d16-8e0c-162c078554f1 has 
  0s and no last_refresh_error from pre-Block-2.7-P1 import. Delete + 
  reimport to test if EnsembleData genuinely can't fetch this 
  shortcode, or if it now works post-P1.
- xcxparadise row from May 6 has dirty query params in embed_url — 
  separate cleanup
- 12 pre-stub-backfill fan_edits rows have creator_id=NULL in 
  production. Block 2.7 P1 prevents new NULLs. Backfill + readd NOT 
  NULL constraint when convenient.
- dpop creator row (78409083) is empty; can soft-delete or leave as 
  scaffolding

UX POLISH:
- Block 3.5: R2 file upload + drag-and-drop + transcoding pipeline 
  for users who want to host video natively on Moonbeem
- Textarea-paste UX for admin bulk upload (paste URLs directly 
  instead of CSV file) — quality-of-life for ad-hoc tests
- Empty-state for /admin/fan-edits/queue: "No pending submissions" 
  copy is fine, but could surface stats (X approved this week, Y 
  rejection rate)

OPERATIONAL:
- Bridge seed handoff to Rohan — needs admin access confirmed + 
  master CSV format documented + pacing plan (200-300 rows/day to 
  stay under EnsembleData ceiling)
- Erupcja case study documentation — Ann's directive, highest 
  bridge-round leverage
- Block C followup #1: clips_and_stills bystander leak fixed in 2.6; 
  Block-D2 queued Resend pipeline for >50 requesters/title still open

ARCHITECTURAL:
- Followup queue per memory 19: RLS read policies on external_clicks, 
  affiliate_links, creators; Block D denormalization for 
  title_offer_id on Flow C clicks; creator_socials.platform CHECK to 
  include 'twitter'; cursor logic improvement; adaptive cron cadence

═══════════════════════════════════════════════════════════════
WHAT'S NEXT — DECISION SPACE
═══════════════════════════════════════════════════════════════

Three converging workstreams for tomorrow:

1. BRIDGE SEED EXECUTION
   - Hand off to Rohan, or run first wave yourself
   - Wave 1: 50-100 high-priority Erupcja-adjacent rows
   - Validate quality of resulting /t/erupcja Fan Edits surface and 
     /c/[handle] stub pages before scaling
   - Spread waves across days for EnsembleData quota headroom

2. BLOCK 3.5 — R2 FILE UPLOAD
   - Verified users upload video files (not just URL paste)
   - Open design questions: transcoding (Cloudflare Stream vs 
     serverless ffmpeg vs accept-as-uploaded), thumbnail extraction, 
     size limits, drag-and-drop UI
   - ~6-8 hour build

3. ERUPCJA CASE STUDY DOCUMENTATION
   - Ann's highest-leverage ask for bridge-round conversations
   - Frame: ~400K platform views, charli_xcx tweet linking to 
     authorized clips, organic remixes across IG/TikTok/Twitter, 
     theater-ticket click-throughs

My read: hand off bridge seed to Rohan as the parallel workstream, 
focus your own time on Erupcja case study or Block 3.5. Bridge-round 
conversations need the case study sooner than they need file upload.

═══════════════════════════════════════════════════════════════
KEY INFRASTRUCTURE STATE
═══════════════════════════════════════════════════════════════

- Production: https://moonbeem.studio
- Local: /Users/dansickles/moonbeem-studio
- GitHub: therealdansickles/moonbeem-studio
- Supabase project ref: qdngcwhubzomwymhaiel
- R2 bucket: moonbeem-studio-assets
- R2 public URL: https://pub-8dcc0cdf788945bc87b3931edd0bb800.r2.dev
- DMCA registration: DMCA-1072736
- Legal entity: Moonbeem, Inc. (Delaware)
- Email sender: hello@moonbeem.studio (Cloudflare Email Routing in, 
  Resend out, display name "Moonbeem")
- Stripe Connect: still sandbox mode
- Resend domain: verified, prefix-free sends confirmed
- Supabase Auth magic link sender: configured separately in 
  Supabase Auth dashboard

═══════════════════════════════════════════════════════════════
TOMORROW'S OPENING POSTURE
═══════════════════════════════════════════════════════════════

Suggested first action: run the DW_-eNWDevP cleanup. Delete the 
ghost row, attempt reimport, see whether Block 2.7 P1 bails or 
imports clean. Five-minute task that closes the last loose thread 
from today and validates the empty-response fix one more time on 
real data.

Then triage: bridge seed wave 1 vs Block 3.5 design vs Erupcja case 
study. Based on bridge-round urgency, case study is probably the 
highest-leverage of the three.

═══════════════════════════════════════════════════════════════
WORKING STYLE PREFERENCES (UNCHANGED)
═══════════════════════════════════════════════════════════════

- Stop offering "should you stop?" framings — I manage my own pacing
- Recon-first discipline before any build
- Single canonical surface per concept, multiple display surfaces 
  with links back
- Brand voice rules are non-negotiable
- Catalog matching: ALWAYS use search_titles RPC, never raw ilike on 
  1.4M rows
- Migrations are truth for live state; build scripts are archeology
- Don't fabricate metrics in any deliverable
- Verify before commit; small commits over large ones

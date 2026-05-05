// Bulk fan_edits CSV upload — admin-facing.
//
// =====================================================================
// CSV COLUMN SPEC (for Rohan / future admins)
// =====================================================================
//
// REQUIRED columns (rejection reason if missing):
//   embed_url       — full URL to the social post (TikTok/IG/YT/Twitter).
//                     TikTok must be canonical /@user/video/{id} form;
//                     vm.tiktok.com / vt.tiktok.com short URLs are
//                     rejected at import time.
//   platform        — one of: tiktok | instagram | youtube | twitter.
//                     'x' is auto-corrected to 'twitter' with a warning
//                     entry. Anything else rejects the row.
//   creator_handle  — the social handle the post was published under.
//                     Leading '@' stripped, lowercased. Empty allowed
//                     (creator_id stays null).
//   title_id        — UUID of the moonbeem title this edit is about.
//                     Verified against the titles table at import time.
//
// RECOMMENDED columns:
//   caption         — post caption / description. Truncated to 500 chars.
//   posted_at       — ISO 8601 timestamp the post went live. Invalid
//                     dates parse as null, not a row rejection.
//   thumbnail_url   — direct URL to a thumbnail image (oembed-derived
//                     thumbnails are also auto-fetched downstream).
//
// OPTIONAL columns (read by spec, currently NOT persisted to fan_edits):
//   creator_display_name
//   creator_email
//   notes
//
// IMPORT BEHAVIOR:
//   - Sync, in-process. 70 rows finishes in seconds.
//   - Idempotent on embed_url: re-running the same CSV is safe;
//     duplicate rows count toward skipped_duplicates.
//   - creator_id is filled by joining creator_socials on (handle,
//     platform). When the creator hasn't been registered yet,
//     creator_id stays null — creator_handle_displayed is always
//     populated from the CSV.
//   - Twitter creator lookup is skipped today: creator_socials.platform
//     constraint allows tiktok|instagram|youtube only. Twitter rows
//     always import with creator_id=null. Fix when Twitter creators
//     exist in the system.
//   - Defaults: verification_status='auto_verified',
//     view_tracking_status='active', is_active=true,
//     view/like/comment/share counts=0. The view-tracking Edge Function
//     fills counts on its next tick.
//
// RESPONSE SHAPE:
//   {
//     imported: int,
//     skipped_duplicates: int,
//     skipped_invalid: int,
//     errors: [{ row: <1-based row number>, embed_url, reason }]
//   }
// =====================================================================

import { requireSuperAdmin } from "@/lib/dal";
import FanEditsUploadClient from "./FanEditsUploadClient";

export default async function FanEditsUploadPage() {
  await requireSuperAdmin();
  return <FanEditsUploadClient />;
}

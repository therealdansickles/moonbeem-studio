// Shared admin fan-edit inserter. Used by both the single-URL flow
// (/api/admin/fan-edits/single) and the bulk-CSV commit flow
// (/api/admin/fan-edits/bulk/commit) so the validation, dedup,
// EnsembleData fetch, and stub-creator resolution stay in one place.
//
// Mirrors the long-standing pattern in /api/admin/fan-edits/import:
//   - verify title exists
//   - dedup against (title_id, post_id) — matches the partial unique
//     index, lets the same URL attach to multiple titles
//   - resolve creator stub via find_or_create_stub_creator
//   - fetch EnsembleData metrics (caller can pass cached metrics to
//     skip a second call within the same admin session)
//   - insert with verification_status='auto_verified' (admin uploads
//     are pre-approved; user uploads in Block 3 will use a different
//     value once the CHECK is extended)
//   - fire fulfillTitleRequestsForFanEdit so request alerts go out

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  fetchEngagementMetrics,
  type FetchEngagementResult,
} from "@/lib/ensembledata/client";
import { fulfillTitleRequestsForFanEdit } from "@/lib/title-requests/fulfill-on-fan-edit";
import { proxyThumbnailToR2 } from "./thumbnail-proxy";
import { getR2PublicUrl } from "@/lib/r2/client";
import type { Platform } from "./url-parser";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAPTION_MAX = 500;

export type AdminFanEditInput = {
  titleId: string;
  embedUrl: string;
  platform: Platform;
  // Derived from URL via parseFanEditUrl; required to enforce the
  // (title_id, post_id) unique index correctly.
  postId: string;
  // The social handle that posted the content (TikTok/Twitter from
  // URL path, Instagram from EnsembleData). Stored in
  // creator_handle_displayed. Distinct from the Moonbeem creator who
  // gets attribution credit (see attributedCreatorId).
  handle?: string | null;
  // Path 1 (admin override): the Moonbeem creator who should receive
  // attribution. When set, becomes fan_edits.creator_id directly —
  // no stub creation. Lets admins attach a post to an existing
  // creator without affecting that creator's creator_socials links.
  //
  // Path 2 (auto): when null, the legacy behavior kicks in —
  // find_or_create_stub_creator(handle, platform) creates a stub
  // if no creator is linked yet, or returns the existing creator_id
  // for that (platform, handle) pair.
  attributedCreatorId?: string | null;
  // Optional caption / notes / posted_at overrides. When omitted,
  // values come from the EnsembleData fetch (where available).
  caption?: string | null;
  postedAtIso?: string | null;
  // Pre-fetched metrics from a preview call. When provided, the
  // inserter trusts them and skips the EnsembleData round-trip. When
  // null, the inserter does the fetch itself.
  prefetchedMetrics?: FetchEngagementResult | null;
  // Block 3 user-submission state. 'auto_verified' (default) is for
  // admin imports — row is immediately public-readable. 'pending' is
  // for user URL-paste submissions awaiting admin review. The admin
  // queue flips 'pending' → 'approved' or 'rejected' via dedicated
  // routes, NOT via this helper.
  verificationStatus?: "auto_verified" | "pending";
  // Who submitted. NULL for admin imports (default); set to the
  // session user_id for user submissions. FK to users.id with ON
  // DELETE SET NULL.
  createdByUserId?: string | null;
};

export type AdminFanEditResult =
  | {
      ok: true;
      fanEditId: string;
      creatorId: string | null;
      metrics: FetchEngagementResult;
    }
  | {
      ok: false;
      reason: string;
      // Symbol for callers that want to switch on the failure
      // category (skip vs. retry vs. surface).
      kind:
        | "invalid_title_id"
        | "title_not_found"
        | "duplicate"
        | "stub_creator_failed"
        | "metrics_fetch_failed"
        | "insert_failed"
        | "internal";
    };

export async function adminInsertFanEdit(
  input: AdminFanEditInput,
  supabase?: SupabaseClient,
): Promise<AdminFanEditResult> {
  const sb = supabase ?? createServiceRoleClient();

  if (!UUID_RE.test(input.titleId)) {
    return { ok: false, kind: "invalid_title_id", reason: "title_id not a valid UUID" };
  }

  const { data: titleRow, error: titleErr } = await sb
    .from("titles")
    .select("id")
    .eq("id", input.titleId)
    .maybeSingle();
  if (titleErr) {
    return { ok: false, kind: "internal", reason: `title lookup failed: ${titleErr.message}` };
  }
  if (!titleRow) {
    return { ok: false, kind: "title_not_found", reason: `title ${input.titleId} not found` };
  }

  // Dedup matches the schema's partial unique index on
  // (title_id, post_id) WHERE post_id IS NOT NULL AND deleted_at IS NULL.
  // Same URL attaching to a different title is allowed.
  const { data: existing, error: existErr } = await sb
    .from("fan_edits")
    .select("id")
    .eq("title_id", input.titleId)
    .eq("post_id", input.postId)
    .is("deleted_at", null)
    .maybeSingle();
  if (existErr) {
    return { ok: false, kind: "internal", reason: `duplicate check failed: ${existErr.message}` };
  }
  if (existing) {
    return {
      ok: false,
      kind: "duplicate",
      reason: "already imported for this title",
    };
  }

  // Resolve creator_id. Two paths:
  //   1. Admin override (attributedCreatorId set) → use it directly.
  //      Do not run the stub-creator RPC. The Moonbeem creator
  //      already exists; we want to attach this post to them
  //      regardless of whether their creator_socials links cover
  //      (platform, handle).
  //   2. Auto (attributedCreatorId null) → legacy find_or_create_
  //      stub_creator(handle, platform). Creates a stub if no
  //      creator is linked for that (platform, handle); otherwise
  //      reuses the existing creator_id.
  //
  // creator_handle_displayed always holds the SOCIAL handle that
  // posted (not the Moonbeem handle) — independent of which path
  // populated creator_id.
  let creatorId: string | null = null;
  let displayedHandle: string | null = null;
  if (input.handle) {
    displayedHandle = input.handle.replace(/^@+/, "").trim().toLowerCase() || null;
  }
  if (input.attributedCreatorId) {
    creatorId = input.attributedCreatorId;
  } else if (displayedHandle) {
    const { data: stubId, error: stubErr } = await sb.rpc(
      "find_or_create_stub_creator",
      { p_handle: displayedHandle, p_platform: input.platform },
    );
    if (stubErr) {
      return {
        ok: false,
        kind: "stub_creator_failed",
        reason: `stub creator resolution failed: ${stubErr.message}`,
      };
    }
    creatorId = stubId as string;
  }

  // Metrics: use the prefetched copy if the caller already paid the
  // EnsembleData call. Otherwise fetch now.
  let metrics: FetchEngagementResult;
  if (input.prefetchedMetrics) {
    metrics = input.prefetchedMetrics;
  } else {
    metrics = await fetchEngagementMetrics({
      platform: input.platform,
      embed_url: input.embedUrl,
    });
  }

  // Bail on metadata-fetch errors before we touch the DB. Previous
  // behavior: ignored metrics.error and inserted whatever-was-returned,
  // which produced ghost rows with creator_id=NULL, thumbnail_url=NULL,
  // view_count=0 when EnsembleData responded 200 with {data: null}
  // (e.g. DXsInL4DTFr smoke test 2026-05-15). The five error
  // categories ('not_found' | 'private' | 'rate_limited' | 'transient'
  // | 'parse_error') all mean we couldn't reliably fetch metadata —
  // none of them justify creating a row. Caller surfaces the reason in
  // the bulk_import_jobs outcome.
  //
  // Note: a successful fetch with empty engagement counts (e.g. an IG
  // carousel with hidden likes) returns metrics.error === null and
  // proceeds normally; the bail only fires on actual fetch failures.
  if (metrics.error) {
    return {
      ok: false,
      kind: "metrics_fetch_failed",
      reason:
        `metadata unavailable (${metrics.error}) — post may be private, deleted, ` +
        `geo-restricted, URL format mismatch, or EnsembleData transient failure`,
    };
  }

  // Thumbnail proxy: Block 2.1 added this for the single-URL flow at
  // /fetch-metadata so the admin preview <img> renders reliably.
  // Bulk imports skipped that preview step, so without this fan_edits
  // landed with raw IG/TikTok CDN URLs that 403 on cross-origin
  // loads. Always proxy here, but skip when the URL is already on
  // our R2 bucket (the single-URL preview already proxied it — same
  // post_id → same key → second upload would just be wasted bytes).
  // Fail-soft: on R2 failure, keep whatever URL we had so the row
  // isn't blocked from inserting.
  if (metrics.thumbnail_url) {
    let r2Prefix: string | null = null;
    try {
      r2Prefix = getR2PublicUrl().replace(/\/$/, "");
    } catch {
      // R2 unconfigured in this environment — skip proxy entirely.
    }
    const alreadyOnR2 =
      r2Prefix !== null && metrics.thumbnail_url.startsWith(r2Prefix);
    if (!alreadyOnR2 && r2Prefix !== null) {
      const proxied = await proxyThumbnailToR2({
        platform: input.platform,
        postId: input.postId,
        thumbnailUrl: metrics.thumbnail_url,
      });
      if (proxied) {
        metrics = { ...metrics, thumbnail_url: proxied };
      }
    }
  }

  // Caption: prefer caller override, else nothing. The metrics return
  // doesn't currently surface caption; the existing import route
  // accepts it as a CSV column.
  const caption = input.caption ? input.caption.slice(0, CAPTION_MAX) : null;
  const postedAt = input.postedAtIso ?? metrics.posted_at ?? null;

  const verificationStatus = input.verificationStatus ?? "auto_verified";
  const insertRow = {
    title_id: input.titleId,
    creator_id: creatorId,
    creator_handle_displayed:
      displayedHandle ?? metrics.creator_handle_displayed ?? null,
    platform: input.platform,
    embed_url: input.embedUrl,
    post_id: input.postId,
    caption,
    posted_at: postedAt,
    view_count: metrics.view_count ?? 0,
    like_count: metrics.like_count ?? 0,
    comment_count: metrics.comment_count ?? 0,
    share_count: metrics.share_count ?? 0,
    thumbnail_url: metrics.thumbnail_url ?? null,
    duration_seconds: metrics.duration_seconds ?? null,
    aspect_ratio: metrics.aspect_ratio ?? null,
    thumbnail_source: metrics.thumbnail_url ? "ensembledata" : null,
    verification_status: verificationStatus,
    created_by_user_id: input.createdByUserId ?? null,
    view_tracking_status: "active",
    last_refreshed_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await sb
    .from("fan_edits")
    .insert(insertRow)
    .select("id")
    .maybeSingle();
  if (insertErr || !inserted) {
    return {
      ok: false,
      kind: "insert_failed",
      reason: `insert failed: ${insertErr?.code ?? ""} ${insertErr?.message ?? "no row returned"}`,
    };
  }

  // Fire request-fulfillment side effect ONLY for rows that are
  // immediately public-readable. Pending user submissions don't
  // fulfill requests until an admin approves them — the approve
  // route fires this hook explicitly at that point.
  if (verificationStatus === "auto_verified") {
    try {
      await fulfillTitleRequestsForFanEdit(
        sb,
        input.titleId,
        inserted.id as string,
      );
    } catch (e) {
      console.error("fulfillTitleRequestsForFanEdit failed (admin insert)", {
        titleId: input.titleId,
        fanEditId: inserted.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: true,
    fanEditId: inserted.id as string,
    creatorId,
    metrics,
  };
}

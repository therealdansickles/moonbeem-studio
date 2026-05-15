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
  // Optional — present on TikTok/Twitter (extracted from path) and
  // Instagram (returned by EnsembleData). YouTube generally null.
  handle?: string | null;
  // Optional caption / notes / posted_at overrides. When omitted,
  // values come from the EnsembleData fetch (where available).
  caption?: string | null;
  postedAtIso?: string | null;
  // Pre-fetched metrics from a preview call. When provided, the
  // inserter trusts them and skips the EnsembleData round-trip. When
  // null, the inserter does the fetch itself.
  prefetchedMetrics?: FetchEngagementResult | null;
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

  // Resolve creator stub. The RPC is upsert-shaped — existing
  // (platform, handle) returns the existing creator_id; otherwise a
  // stub creator + creator_socials row is created in one transaction.
  let creatorId: string | null = null;
  let displayedHandle: string | null = null;
  if (input.handle) {
    displayedHandle = input.handle.replace(/^@+/, "").trim().toLowerCase();
    if (displayedHandle) {
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

  // EnsembleData errors don't block the insert — view-tracking will
  // retry on the next sweep. We just record what we have.
  // (Counters fall back to 0 via schema default when null.)

  // Caption: prefer caller override, else nothing. The metrics return
  // doesn't currently surface caption; the existing import route
  // accepts it as a CSV column.
  const caption = input.caption ? input.caption.slice(0, CAPTION_MAX) : null;
  const postedAt = input.postedAtIso ?? metrics.posted_at ?? null;

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
    verification_status: "auto_verified",
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

  // Fire request-fulfillment side effect; failures are logged but
  // don't roll back the insert.
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

  return {
    ok: true,
    fanEditId: inserted.id as string,
    creatorId,
    metrics,
  };
}

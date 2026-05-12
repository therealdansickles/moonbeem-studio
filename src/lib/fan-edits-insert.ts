// Shared fan_edits insert helper used by the Discover tab's
// /api/admin/titles/[slug]/discover/add route. Mirrors the per-row
// path in /api/admin/fan-edits/import (CSV importer): dedupe by
// embed_url, resolve creator via find_or_create_stub_creator stub
// flow, then insert with view_tracking_status='active' so the next
// view-tracking cron tick picks it up.
//
// The CSV importer's outer loop (CSV parsing, row-number error
// reporting, platform auto-correct warnings) stays bespoke to that
// route; only the inner "given a validated candidate, insert" unit
// is shared. Refactoring the CSV importer to call this helper is
// possible but out of scope for the discovery work — the importer
// currently runs fine and rewriting it raises regression risk on a
// path that's used live.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseShortcodeFromUrl } from "@/lib/ensembledata/client";
import { fulfillTitleRequestsForFanEdit } from "@/lib/title-requests/fulfill-on-fan-edit";

export type FanEditCandidate = {
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  creator_handle: string | null;
  caption: string | null;
  posted_at: string | null;
  thumbnail_url: string | null;
  // Optional initial counter seeds. View-tracking will overwrite on
  // its next refresh tick, but seeding from the search response
  // gives the partner dashboard immediate signal before that tick
  // lands.
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  share_count?: number | null;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
};

export type InsertOutcome =
  | { ok: true; inserted_id: string }
  | { ok: false; reason: "duplicate"; existing_id: string }
  | { ok: false; reason: "parse_failure" | "stub_failed" | "insert_failed"; detail: string };

const CAPTION_MAX = 500;

export async function insertFanEditCandidate(
  supabase: SupabaseClient,
  titleId: string,
  c: FanEditCandidate,
): Promise<InsertOutcome> {
  // Validate URL parses for the platform's id/shortcode pattern.
  const shortcode = parseShortcodeFromUrl(c.embed_url, c.platform);
  if (!shortcode) {
    return {
      ok: false,
      reason: "parse_failure",
      detail: `embed_url did not match ${c.platform} id pattern`,
    };
  }

  // Idempotency: skip if an existing fan_edit already has this URL.
  // CSV importer treats this as "already_imported"; we surface the
  // existing id so the UI can mark the row as already-in-library.
  const { data: existing, error: existErr } = await supabase
    .from("fan_edits")
    .select("id")
    .eq("embed_url", c.embed_url)
    .maybeSingle();
  if (existErr) {
    return { ok: false, reason: "insert_failed", detail: existErr.message };
  }
  if (existing) {
    return { ok: false, reason: "duplicate", existing_id: existing.id as string };
  }

  // Creator resolution. Strip leading @, lowercase. find_or_create_stub_creator
  // RPC handles both "lookup existing (platform, handle) creator_socials row
  // and reuse" + "create stub + socials in one transaction".
  let creatorId: string | null = null;
  let displayedHandle: string | null = null;
  if (c.creator_handle) {
    displayedHandle = c.creator_handle.replace(/^@+/, "").trim().toLowerCase();
    if (displayedHandle) {
      const { data: stubId, error: stubErr } = await supabase.rpc(
        "find_or_create_stub_creator",
        { p_handle: displayedHandle, p_platform: c.platform },
      );
      if (stubErr) {
        return {
          ok: false,
          reason: "stub_failed",
          detail: stubErr.message,
        };
      }
      creatorId = stubId as string;
    }
  }

  const insertRow: Record<string, unknown> = {
    title_id: titleId,
    creator_id: creatorId,
    creator_handle_displayed: displayedHandle,
    platform: c.platform,
    embed_url: c.embed_url,
    // post_id derived from URL via parseShortcodeFromUrl above.
    // Stored to enable canonical (title_id, post_id) dedupe across
    // import paths — embed_url alone leaks across URL variants.
    post_id: shortcode,
    caption: c.caption ? c.caption.slice(0, CAPTION_MAX) : null,
    posted_at: c.posted_at,
    thumbnail_url: c.thumbnail_url,
    verification_status: "auto_verified",
    view_tracking_status: "active",
  };
  // Seed counters when provided — view-tracking will overwrite. No-op
  // when the caller (e.g. CSV) doesn't pass them.
  if (typeof c.view_count === "number") insertRow.view_count = c.view_count;
  if (typeof c.like_count === "number") insertRow.like_count = c.like_count;
  if (typeof c.comment_count === "number") {
    insertRow.comment_count = c.comment_count;
  }
  if (typeof c.share_count === "number") {
    insertRow.share_count = c.share_count;
  }
  if (typeof c.duration_seconds === "number") {
    insertRow.duration_seconds = c.duration_seconds;
  }
  if (typeof c.aspect_ratio === "string") {
    insertRow.aspect_ratio = c.aspect_ratio;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("fan_edits")
    .insert(insertRow)
    .select("id")
    .maybeSingle();
  if (insertErr || !inserted) {
    return {
      ok: false,
      reason: "insert_failed",
      detail: insertErr?.message ?? "no row returned",
    };
  }

  const insertedId = inserted.id as string;
  try {
    await fulfillTitleRequestsForFanEdit(supabase, titleId, insertedId);
  } catch (e) {
    console.error("fulfillTitleRequestsForFanEdit failed", {
      titleId,
      fanEditId: insertedId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { ok: true, inserted_id: insertedId };
}

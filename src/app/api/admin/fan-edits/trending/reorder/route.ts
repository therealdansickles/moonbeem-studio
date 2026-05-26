// POST /api/admin/fan-edits/trending/reorder — super-admin curation
// of the homepage Trending Edits carousel. Mechanical clone of
// /api/admin/fan-edits/recent/reorder with column-name swaps
// (trending_pin_order, is_hidden_from_trending) and an extra
// view_tracking_status='active' clause on the canonical-gate
// backstop (so dead-on-platform / private rows can't be pinned or
// hidden — pin would render a broken embed).
//
// Body shape:
//   {
//     pinned: [{ fan_edit_id: uuid, pin_order: 1..N }, …],
//     hidden: [uuid, …]
//   }
//
// Semantics: full-state declaration. Pinned-not-in-new → unpinned;
// hidden-not-in-new → unhidden. Hide also clears any stale
// pin_order to enforce the no-pin-while-hidden invariant. Two-phase
// pin write (TEMP_OFFSET = 10_000) future-proofs a potential UNIQUE
// on trending_pin_order.
//
// revalidatePath('/') on success.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ENTRIES = 100;
const TEMP_OFFSET = 10_000;

type PinEntry = { fan_edit_id: string; pin_order: number };

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/fan-edits/trending/reorder",
  );
  if (!limit.ok) return limit.response;

  let body: { pinned?: PinEntry[]; hidden?: string[] };
  try {
    body = (await request.json()) as {
      pinned?: PinEntry[];
      hidden?: string[];
    };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const pinnedIn = Array.isArray(body.pinned) ? body.pinned : [];
  const hiddenIn = Array.isArray(body.hidden) ? body.hidden : [];

  if (pinnedIn.length > MAX_ENTRIES) {
    return NextResponse.json({ error: "too_many_pinned" }, { status: 400 });
  }
  if (hiddenIn.length > MAX_ENTRIES) {
    return NextResponse.json({ error: "too_many_hidden" }, { status: 400 });
  }

  const pinnedSeenIds = new Set<string>();
  const pinnedSeenPos = new Set<number>();
  for (const e of pinnedIn) {
    const fid = (e?.fan_edit_id ?? "").trim();
    const pos = Number(e?.pin_order);
    if (!UUID_RE.test(fid)) {
      return NextResponse.json(
        { error: "invalid_fan_edit_id" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > MAX_ENTRIES) {
      return NextResponse.json(
        { error: "invalid_pin_order" },
        { status: 400 },
      );
    }
    if (pinnedSeenIds.has(fid)) {
      return NextResponse.json(
        { error: "duplicate_fan_edit_id" },
        { status: 400 },
      );
    }
    if (pinnedSeenPos.has(pos)) {
      return NextResponse.json(
        { error: "duplicate_pin_order" },
        { status: 400 },
      );
    }
    pinnedSeenIds.add(fid);
    pinnedSeenPos.add(pos);
  }

  const hiddenSeen = new Set<string>();
  for (const id of hiddenIn) {
    const fid = (id ?? "").trim();
    if (!UUID_RE.test(fid)) {
      return NextResponse.json(
        { error: "invalid_fan_edit_id" },
        { status: 400 },
      );
    }
    if (hiddenSeen.has(fid)) {
      return NextResponse.json(
        { error: "duplicate_hidden_id" },
        { status: 400 },
      );
    }
    hiddenSeen.add(fid);
  }

  for (const id of pinnedSeenIds) {
    if (hiddenSeen.has(id)) {
      return NextResponse.json(
        { error: "fan_edit_both_pinned_and_hidden", fan_edit_id: id },
        { status: 400 },
      );
    }
  }

  const supabase = createServiceRoleClient();

  // Canonical fan_edit gate + view_tracking_status='active' on every
  // referenced fan_edit. Matches the curator's data-loader gate and
  // the homepage getTrendingFanEdits gate, so pinning a dead-on-
  // platform / private row is impossible by construction.
  const referencedIds = [...pinnedSeenIds, ...hiddenSeen];
  if (referencedIds.length > 0) {
    const { data: valid, error: readErr } = await supabase
      .from("fan_edits")
      .select("id")
      .in("id", referencedIds)
      .eq("is_active", true)
      .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
      .eq("view_tracking_status", "active")
      .is("deleted_at", null);
    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    const validSet = new Set((valid ?? []).map((r) => r.id as string));
    for (const id of referencedIds) {
      if (!validSet.has(id)) {
        return NextResponse.json(
          { error: "fan_edit_not_curatable", fan_edit_id: id },
          { status: 400 },
        );
      }
    }
  }

  // Current state lookup so we can diff and apply only the changes.
  const [currentPinnedRes, currentHiddenRes] = await Promise.all([
    supabase
      .from("fan_edits")
      .select("id")
      .not("trending_pin_order", "is", null),
    supabase
      .from("fan_edits")
      .select("id")
      .eq("is_hidden_from_trending", true),
  ]);
  if (currentPinnedRes.error) {
    return NextResponse.json(
      { error: currentPinnedRes.error.message },
      { status: 500 },
    );
  }
  if (currentHiddenRes.error) {
    return NextResponse.json(
      { error: currentHiddenRes.error.message },
      { status: 500 },
    );
  }
  const currentPinned = new Set(
    (currentPinnedRes.data ?? []).map((r) => r.id as string),
  );
  const currentHidden = new Set(
    (currentHiddenRes.data ?? []).map((r) => r.id as string),
  );

  const newPinned = pinnedSeenIds;
  const newHidden = hiddenSeen;

  // 1. Unpin anyone currently pinned but absent from new.
  const toUnpin = [...currentPinned].filter((id) => !newPinned.has(id));
  if (toUnpin.length > 0) {
    const { error } = await supabase
      .from("fan_edits")
      .update({ trending_pin_order: null })
      .in("id", toUnpin);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 2. Unhide anyone currently hidden but absent from new.
  const toUnhide = [...currentHidden].filter((id) => !newHidden.has(id));
  if (toUnhide.length > 0) {
    const { error } = await supabase
      .from("fan_edits")
      .update({ is_hidden_from_trending: false })
      .in("id", toUnhide);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 3. Hide every id in newHidden (idempotent on already-hidden).
  //    Also clears any stale pin_order — no-pin-while-hidden invariant.
  if (newHidden.size > 0) {
    const { error } = await supabase
      .from("fan_edits")
      .update({
        is_hidden_from_trending: true,
        trending_pin_order: null,
      })
      .in("id", [...newHidden]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 4. Two-phase pin write — bump to TEMP_OFFSET range, then settle.
  if (pinnedIn.length > 0) {
    for (let i = 0; i < pinnedIn.length; i++) {
      const { error } = await supabase
        .from("fan_edits")
        .update({
          trending_pin_order: TEMP_OFFSET + i,
          is_hidden_from_trending: false,
        })
        .eq("id", pinnedIn[i].fan_edit_id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    for (const e of pinnedIn) {
      const { error } = await supabase
        .from("fan_edits")
        .update({ trending_pin_order: e.pin_order })
        .eq("id", e.fan_edit_id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  revalidatePath("/");
  return NextResponse.json({ success: true });
}

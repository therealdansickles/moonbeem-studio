// POST /api/admin/titles/allfilms/reorder — super-admin curation of
// the homepage All Films carousel. Mirrors
// /api/admin/fan-edits/recent/reorder exactly but on titles. One
// endpoint handles every state mutation (pin, unpin, reorder, hide,
// unhide); the body is a complete declaration of the new pinned +
// hidden state.
//
// Body shape:
//   {
//     pinned: [{ title_id: uuid, pin_order: 1..N }, …],
//     hidden: [uuid, …]
//   }
//
// Semantics: full-state declaration. Pinned-not-in-new → unpinned.
// Hidden-not-in-new → unhidden. Hidden also clears any stale
// pin_order to enforce the no-pin-while-hidden invariant.
//
// Canonical gate on every referenced title: is_public AND is_active
// AND media_type='movie'. Caller (the curator UI) should never
// declare an invalid candidate; this gate is the server backstop.
//
// Two-phase pin write (TEMP_OFFSET=10_000) future-proofs a potential
// UNIQUE on allfilms_pin_order.
//
// revalidatePath('/') so the homepage reflects the new state on the
// next visit.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { enforce } from "@/lib/ratelimit";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ENTRIES = 100;
const TEMP_OFFSET = 10_000;

type PinEntry = { title_id: string; pin_order: number };

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin();
  const limit = await enforce(
    "admin",
    session.userId,
    "admin/titles/allfilms/reorder",
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
    const tid = (e?.title_id ?? "").trim();
    const pos = Number(e?.pin_order);
    if (!UUID_RE.test(tid)) {
      return NextResponse.json(
        { error: "invalid_title_id" },
        { status: 400 },
      );
    }
    if (!Number.isInteger(pos) || pos < 1 || pos > MAX_ENTRIES) {
      return NextResponse.json(
        { error: "invalid_pin_order" },
        { status: 400 },
      );
    }
    if (pinnedSeenIds.has(tid)) {
      return NextResponse.json(
        { error: "duplicate_title_id" },
        { status: 400 },
      );
    }
    if (pinnedSeenPos.has(pos)) {
      return NextResponse.json(
        { error: "duplicate_pin_order" },
        { status: 400 },
      );
    }
    pinnedSeenIds.add(tid);
    pinnedSeenPos.add(pos);
  }

  const hiddenSeen = new Set<string>();
  for (const id of hiddenIn) {
    const tid = (id ?? "").trim();
    if (!UUID_RE.test(tid)) {
      return NextResponse.json(
        { error: "invalid_title_id" },
        { status: 400 },
      );
    }
    if (hiddenSeen.has(tid)) {
      return NextResponse.json(
        { error: "duplicate_hidden_id" },
        { status: 400 },
      );
    }
    hiddenSeen.add(tid);
  }

  for (const id of pinnedSeenIds) {
    if (hiddenSeen.has(id)) {
      return NextResponse.json(
        { error: "title_both_pinned_and_hidden", title_id: id },
        { status: 400 },
      );
    }
  }

  const supabase = createServiceRoleClient();

  // Canonical All Films gate on every referenced title.
  const referencedIds = [...pinnedSeenIds, ...hiddenSeen];
  if (referencedIds.length > 0) {
    const { data: valid, error: readErr } = await supabase
      .from("titles")
      .select("id")
      .in("id", referencedIds)
      .eq("is_public", true)
      .eq("is_active", true)
      .eq("media_type", "movie");
    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    const validSet = new Set((valid ?? []).map((r) => r.id as string));
    for (const id of referencedIds) {
      if (!validSet.has(id)) {
        return NextResponse.json(
          { error: "title_not_curatable", title_id: id },
          { status: 400 },
        );
      }
    }
  }

  // Current state lookup so we can diff and apply only the changes.
  const [currentPinnedRes, currentHiddenRes] = await Promise.all([
    supabase
      .from("titles")
      .select("id")
      .not("allfilms_pin_order", "is", null),
    supabase
      .from("titles")
      .select("id")
      .eq("is_hidden_from_all_films", true),
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
      .from("titles")
      .update({ allfilms_pin_order: null })
      .in("id", toUnpin);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 2. Unhide anyone currently hidden but absent from new.
  const toUnhide = [...currentHidden].filter((id) => !newHidden.has(id));
  if (toUnhide.length > 0) {
    const { error } = await supabase
      .from("titles")
      .update({ is_hidden_from_all_films: false })
      .in("id", toUnhide);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 3. Hide every id in newHidden (idempotent on already-hidden).
  //    Also clears any stale pin_order — no-pin-while-hidden invariant.
  if (newHidden.size > 0) {
    const { error } = await supabase
      .from("titles")
      .update({ is_hidden_from_all_films: true, allfilms_pin_order: null })
      .in("id", [...newHidden]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  // 4. Two-phase pin write — bump to TEMP_OFFSET range, then settle.
  if (pinnedIn.length > 0) {
    for (let i = 0; i < pinnedIn.length; i++) {
      const { error } = await supabase
        .from("titles")
        .update({
          allfilms_pin_order: TEMP_OFFSET + i,
          is_hidden_from_all_films: false,
        })
        .eq("id", pinnedIn[i].title_id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
    for (const e of pinnedIn) {
      const { error } = await supabase
        .from("titles")
        .update({ allfilms_pin_order: e.pin_order })
        .eq("id", e.title_id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  revalidatePath("/");
  return NextResponse.json({ success: true });
}

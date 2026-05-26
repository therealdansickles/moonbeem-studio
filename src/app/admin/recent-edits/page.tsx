// /admin/recent-edits — super-admin curation of the homepage Recent
// Edits carousel. Mirrors /admin/featured + /admin/marquee:
//   1. Reorder pinned via drag-and-drop (persists recent_pin_order).
//   2. Hide a fan_edit from the carousel (persists
//      is_hidden_from_recent = true) without affecting any other
//      surface.
//   3. Pin a candidate (recent_pin_order = next-available) from the
//      filterable candidate pool.
//   4. Unpin / Unhide reverse those operations.
//
// The carousel on the homepage reads getRecentFanEdits(), now
// ordered by recent_pin_order ASC NULLS LAST, then created_at DESC,
// filtered to is_hidden_from_recent=false. Mutation calls
// revalidatePath('/') so the carousel reflects changes on the next
// visit.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";
import RecentEditsCurator, {
  type RecentCurationItem,
} from "./RecentEditsCurator";

export const metadata: Metadata = {
  title: "Recent Edits curation · Moonbeem admin",
  robots: { index: false, follow: false },
};

type FanEditRow = {
  id: string;
  title_id: string;
  platform: "tiktok" | "instagram" | "youtube" | "twitter";
  embed_url: string;
  thumbnail_url: string | null;
  creator_handle_displayed: string | null;
  creator_id: string | null;
  created_at: string;
  recent_pin_order: number | null;
  is_hidden_from_recent: boolean;
  titles: {
    slug: string;
    title: string;
    poster_url: string | null;
    is_active: boolean;
  } | null;
};

// Bounded candidate pool — the unpinned-unhidden set, top 100 by
// created_at DESC. Plenty of headroom over today's ~290 active fan_edits;
// admin filters in-memory client-side.
const CANDIDATE_POOL_LIMIT = 100;

const FAN_EDIT_SELECT =
  "id, title_id, platform, embed_url, thumbnail_url, creator_handle_displayed, creator_id, created_at, recent_pin_order, is_hidden_from_recent, titles!inner(slug, title, poster_url, is_active)";

function mapRow(
  r: FanEditRow,
  creatorHandleById: Map<string, string>,
): RecentCurationItem | null {
  if (!r.titles) return null;
  const moonbeemHandle = r.creator_id
    ? (creatorHandleById.get(r.creator_id) ?? null)
    : null;
  return {
    id: r.id,
    title_id: r.title_id,
    title_name: r.titles.title,
    title_slug: r.titles.slug,
    title_poster_url: r.titles.poster_url,
    platform: r.platform,
    thumbnail_url: r.thumbnail_url,
    creator_handle:
      moonbeemHandle ?? r.creator_handle_displayed ?? "anon",
    created_at: r.created_at,
    recent_pin_order: r.recent_pin_order,
    is_hidden_from_recent: r.is_hidden_from_recent,
  };
}

export default async function AdminRecentEditsPage() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  // Single-shot fetch of all curator-relevant fan_edits. Canonical
  // three-clause gate (is_active + verification_status + deleted_at);
  // titles must also be active. We sort client-side into pinned /
  // hidden / candidate buckets so the admin sees ONLY rows the
  // homepage would consider — no curating something the gate would
  // drop anyway.
  const { data: pinnedRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .not("recent_pin_order", "is", null)
    .order("recent_pin_order", { ascending: true });

  const { data: hiddenRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .eq("is_hidden_from_recent", true)
    .order("created_at", { ascending: false });

  const { data: candidatesRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .is("recent_pin_order", null)
    .eq("is_hidden_from_recent", false)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_POOL_LIMIT);

  const pinnedRows = (pinnedRaw ?? []) as unknown as FanEditRow[];
  const hiddenRows = (hiddenRaw ?? []) as unknown as FanEditRow[];
  const candidateRows = (candidatesRaw ?? []) as unknown as FanEditRow[];

  // One creator-handle lookup across all three sets.
  const creatorIds = Array.from(
    new Set(
      [...pinnedRows, ...hiddenRows, ...candidateRows]
        .map((r) => r.creator_id)
        .filter((id): id is string => !!id),
    ),
  );
  const creatorHandleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of (creators ?? []) as Array<{
      id: string;
      moonbeem_handle: string;
    }>) {
      creatorHandleById.set(c.id, c.moonbeem_handle);
    }
  }

  const pinned = pinnedRows
    .map((r) => mapRow(r, creatorHandleById))
    .filter((x): x is RecentCurationItem => x !== null);
  const hidden = hiddenRows
    .map((r) => mapRow(r, creatorHandleById))
    .filter((x): x is RecentCurationItem => x !== null);
  const candidates = candidateRows
    .map((r) => mapRow(r, creatorHandleById))
    .filter((x): x is RecentCurationItem => x !== null);

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Recent Edits curation
          </h1>
          <Link
            href="/admin/homepage"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to homepage curation
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate the homepage Recent Edits carousel. Drag pinned rows to
          reorder; X to unpin; eye icon to hide. Search the candidate
          pool below to find more edits to pin or hide.
        </p>
        <RecentEditsCurator
          initialPinned={pinned}
          initialHidden={hidden}
          initialCandidates={candidates}
        />
      </div>
    </div>
  );
}

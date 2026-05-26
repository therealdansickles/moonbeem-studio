// /admin/trending-edits — super-admin curation of the homepage
// Trending Edits carousel. Mirrors /admin/recent-edits's three-
// section shape (Pinned / Hidden / Candidates) but with one
// important behavioral difference, documented in the page copy:
// pinning a fan_edit on Trending BYPASSES SNAPSHOT-COVERAGE. The
// homepage Trending query has an inner-join requirement (latest +
// ≥24h-ago snapshots) that the algorithmic delta needs; pinned
// rows skip that requirement entirely, so an admin can pin a
// freshly-imported fan_edit and it surfaces immediately.
//
// All three lists (pinned, hidden, candidates) honor the canonical
// fan_edit gate (is_active + verification_status + deleted_at IS
// NULL) AND view_tracking_status='active' — same gate the homepage
// query uses, so the curator never shows a row the homepage would
// reject.
//
// Mutation calls revalidatePath('/') via the API route so the
// homepage reflects changes on the next visit.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { PUBLICLY_READABLE_FAN_EDIT_STATUSES } from "@/lib/fan-edits/status";
import TrendingEditsCurator, {
  type TrendingCurationItem,
} from "./TrendingEditsCurator";

export const metadata: Metadata = {
  title: "Trending Edits curation · Moonbeem admin",
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
  trending_pin_order: number | null;
  is_hidden_from_trending: boolean;
  titles: {
    slug: string;
    title: string;
    poster_url: string | null;
    is_active: boolean;
  } | null;
};

const CANDIDATE_POOL_LIMIT = 100;

const FAN_EDIT_SELECT =
  "id, title_id, platform, embed_url, thumbnail_url, creator_handle_displayed, creator_id, created_at, trending_pin_order, is_hidden_from_trending, titles!inner(slug, title, poster_url, is_active)";

function mapRow(
  r: FanEditRow,
  creatorHandleById: Map<string, string>,
): TrendingCurationItem | null {
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
    trending_pin_order: r.trending_pin_order,
    is_hidden_from_trending: r.is_hidden_from_trending,
  };
}

export default async function AdminTrendingEditsPage() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  // All three queries share the canonical fan_edit gate + view-
  // tracking-active filter. View-tracking-active is preserved here
  // (and in the homepage's getTrendingFanEdits) so dead-on-platform
  // / private rows can't be pinned or hidden — pin would render a
  // broken embed; hide is meaningless for a row that's already
  // unrenderable.
  const { data: pinnedRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .eq("view_tracking_status", "active")
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .not("trending_pin_order", "is", null)
    .order("trending_pin_order", { ascending: true });

  const { data: hiddenRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .eq("view_tracking_status", "active")
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .eq("is_hidden_from_trending", true)
    .order("created_at", { ascending: false });

  const { data: candidatesRaw } = await supabase
    .from("fan_edits")
    .select(FAN_EDIT_SELECT)
    .eq("is_active", true)
    .in("verification_status", PUBLICLY_READABLE_FAN_EDIT_STATUSES)
    .eq("view_tracking_status", "active")
    .is("deleted_at", null)
    .eq("titles.is_active", true)
    .is("trending_pin_order", null)
    .eq("is_hidden_from_trending", false)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_POOL_LIMIT);

  const pinnedRows = (pinnedRaw ?? []) as unknown as FanEditRow[];
  const hiddenRows = (hiddenRaw ?? []) as unknown as FanEditRow[];
  const candidateRows = (candidatesRaw ?? []) as unknown as FanEditRow[];

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
    .filter((x): x is TrendingCurationItem => x !== null);
  const hidden = hiddenRows
    .map((r) => mapRow(r, creatorHandleById))
    .filter((x): x is TrendingCurationItem => x !== null);
  const candidates = candidateRows
    .map((r) => mapRow(r, creatorHandleById))
    .filter((x): x is TrendingCurationItem => x !== null);

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Trending Edits curation
          </h1>
          <Link
            href="/admin/homepage"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to homepage curation
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate the homepage Trending Edits carousel. Trending is
          algorithmic — fan_edits with a 24h view-count delta are
          ranked DESC and the top N fill the carousel. Pinning a
          fan_edit overrides the algorithm AND bypasses the snapshot-
          coverage requirement, so a freshly-imported edit (no
          view-tracking history yet) can be pinned and shown
          immediately. Hide removes a fan_edit from Trending only;
          Recent / Featured surfaces are unaffected.
        </p>
        <TrendingEditsCurator
          initialPinned={pinned}
          initialHidden={hidden}
          initialCandidates={candidates}
        />
      </div>
    </div>
  );
}

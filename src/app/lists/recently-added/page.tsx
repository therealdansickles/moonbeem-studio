// /lists/recently-added — dedicated page for the most recently added
// public catalog titles. Static route, queries directly, shares
// ListPageLayout.
//
// Capped at 200. The public catalog (is_public + is_active +
// media_type=movie) is small today (~dozen titles), so the cap is
// pure future-proofing — it keeps the page bounded as the catalog
// grows rather than rendering an unbounded grid. If "recent" should
// become time-windowed (last N days) instead of a flat cap, that's
// a followup.

import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";
import ListPageLayout from "../ListPageLayout";
import type { ListSlot } from "../ListPageClient";

const RECENT_CAP = 200;

export const metadata: Metadata = {
  title: "Recently Added · Moonbeem",
  description:
    "The newest titles on Moonbeem. Add them to your own top 12.",
  openGraph: {
    title: "Recently Added · Moonbeem",
    description: "The newest titles on Moonbeem.",
    type: "website",
  },
};

export default async function RecentlyAddedListPage() {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("titles")
    .select("id, slug, title, poster_url, year, distributor")
    .eq("is_public", true)
    .eq("is_active", true)
    .eq("media_type", "movie")
    .order("created_at", { ascending: false })
    .limit(RECENT_CAP);

  const rows = (data ?? []) as Array<{
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
    year: number | null;
    distributor: string | null;
  }>;
  const slots: ListSlot[] = rows.map((t, i) => ({
    position: i + 1,
    title: {
      id: t.id,
      slug: t.slug,
      title: t.title,
      poster_url: t.poster_url,
      year: t.year,
      distributor: t.distributor,
    },
  }));

  return (
    <ListPageLayout
      name="Recently Added"
      description={null}
      itemCount={slots.length}
      noun="films"
      slots={slots}
      pagePath="/lists/recently-added"
    />
  );
}

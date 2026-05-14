// /me/top-12 — dedicated Top 12 builder.
//
// Server component: gates on auth + claimed handle, then fans out
// the reads the builder needs — the user's current picks, plus the
// three browse surfaces (Featured, Recently added, By partner). The
// interactive surface is the "use client" Top12Builder.
//
// Browse data is scoped to the public catalog (getAllFilms filters
// is_public + is_active + media_type=movie). By-partner sections are
// derived by grouping that same list — no extra per-partner queries.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getTopTitlesForUser } from "@/lib/queries/profiles";
import {
  getFeaturedTitles,
  getAllFilms,
  type Title,
} from "@/lib/queries/titles";
import Top12Builder, {
  type BuilderTitle,
  type BuilderPick,
  type PartnerSection,
  type CuratedListSection,
} from "./Top12Builder";

const CURATED_TITLES_PER_LIST = 24;

type CuratedTitleJoin = {
  curated_list_id: string;
  position: number;
  titles: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
    year: number | null;
    distributor: string | null;
  } | null;
};

export const metadata: Metadata = {
  title: "Build your top 12 · Moonbeem",
  robots: { index: false, follow: false },
};

function toBuilderTitle(t: Title): BuilderTitle {
  return {
    id: t.id,
    slug: t.slug,
    title: t.title,
    poster_url: t.poster_url,
    year: t.year,
    distributor: t.distributor,
  };
}

export default async function Top12BuilderPage() {
  const session = await verifySession();
  const service = createServiceRoleClient();

  // Handle gate — same as /me and /me/edit: a user without a claimed
  // handle goes through onboarding first.
  const { data: userRow } = await service
    .from("users")
    .select("handle")
    .eq("id", session.userId)
    .maybeSingle();
  if (!userRow?.handle) redirect("/onboarding/handle");

  const [topTitles, featured, allFilms, partnersRes] = await Promise.all([
    getTopTitlesForUser(session.userId),
    getFeaturedTitles(),
    getAllFilms(),
    service.from("partners").select("id, slug, name").order("name"),
  ]);

  const initialPicks: BuilderPick[] = topTitles.map((t) => ({
    title_id: t.title_id,
    position: t.position,
    slug: t.title.slug,
    title: t.title.title,
    poster_url: t.title.poster_url,
  }));

  const featuredTitles = featured.map(toBuilderTitle);
  const recentlyAdded = allFilms.map(toBuilderTitle);

  const partners = (partnersRes.data ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
  }>;
  const byPartner: PartnerSection[] = partners
    .map((p) => ({
      partner: p,
      titles: allFilms
        .filter((t) => t.partner_id === p.id)
        .map(toBuilderTitle),
    }))
    .filter((section) => section.titles.length > 0);

  // Curated discovery carousels (AFI Top 100, Greatest TV Shows, ...).
  // Visible lists ordered by display_order; their titles joined and
  // position-ordered. One batched curated_list_titles query covers
  // all lists; grouped + capped per list in JS.
  const { data: curatedListRows } = await service
    .from("curated_lists")
    .select("id, slug, name, display_order")
    .eq("is_visible", true)
    .order("display_order");
  const curatedListIds = (curatedListRows ?? []).map((l) => l.id as string);
  const { data: curatedTitleRows } = curatedListIds.length
    ? await service
        .from("curated_list_titles")
        .select(
          "curated_list_id, position, titles:title_id(id, slug, title, poster_url, year, distributor)",
        )
        .in("curated_list_id", curatedListIds)
        .order("position")
    : { data: [] };

  const curatedTitlesByList = new Map<string, BuilderTitle[]>();
  for (const row of (curatedTitleRows ?? []) as unknown as CuratedTitleJoin[]) {
    const t = row.titles;
    if (!t) continue;
    const arr = curatedTitlesByList.get(row.curated_list_id) ?? [];
    if (arr.length < CURATED_TITLES_PER_LIST) {
      arr.push({
        id: t.id,
        slug: t.slug,
        title: t.title,
        poster_url: t.poster_url,
        year: t.year,
        distributor: t.distributor,
      });
    }
    curatedTitlesByList.set(row.curated_list_id, arr);
  }
  const curatedLists: CuratedListSection[] = (curatedListRows ?? [])
    .map((l) => ({
      slug: l.slug as string,
      name: l.name as string,
      titles: curatedTitlesByList.get(l.id as string) ?? [],
    }))
    .filter((section) => section.titles.length > 0);

  return (
    <Top12Builder
      initialPicks={initialPicks}
      featured={featuredTitles}
      curatedLists={curatedLists}
      recentlyAdded={recentlyAdded}
      byPartner={byPartner}
    />
  );
}

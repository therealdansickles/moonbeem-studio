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
} from "./Top12Builder";

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

  return (
    <Top12Builder
      initialPicks={initialPicks}
      featured={featuredTitles}
      recentlyAdded={recentlyAdded}
      byPartner={byPartner}
    />
  );
}

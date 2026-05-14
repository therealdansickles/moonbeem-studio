// /lists/[slug] — dedicated page for a curated list (AFI Top 100,
// Top Rated Series, and future Classic Favorites / Trending).
//
// Public: anyone can browse. The +Add affordance on each card works
// for signed-in users and prompts sign-in for everyone else — that
// gating lives in the "use client" ListPageClient. Server side just
// resolves the list, builds the position slots (matched titles plus
// explicit placeholders for unmatched-catalog gaps), and reads the
// viewer's current Top 12 so cards render in the right state.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getTopTitlesForUser } from "@/lib/queries/profiles";
import type { BuilderTitle } from "@/app/me/top-12/Top12Builder";
import ListPageClient, { type ListSlot } from "./ListPageClient";

type PageProps = { params: Promise<{ slug: string }> };

type TitleJoin = {
  position: number;
  titles: {
    id: string;
    slug: string;
    title: string;
    poster_url: string | null;
    year: number | null;
    distributor: string | null;
    media_type: string | null;
  } | null;
};

async function fetchList(slug: string) {
  const service = createServiceRoleClient();
  const { data: list } = await service
    .from("curated_lists")
    .select("id, slug, name, description")
    .eq("slug", slug)
    .eq("is_visible", true)
    .maybeSingle();
  return { service, list };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { list } = await fetchList(slug);
  if (!list) return { title: "List not found · Moonbeem" };
  const description =
    (list.description as string | null) ??
    `${list.name} — a curated list on Moonbeem. Add titles to your own top 12.`;
  const title = `${list.name} · Moonbeem`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
  };
}

export default async function ListPage({ params }: PageProps) {
  const { slug } = await params;
  const { service, list } = await fetchList(slug);
  if (!list) notFound();

  const { data: rows } = await service
    .from("curated_list_titles")
    .select(
      "position, titles:title_id(id, slug, title, poster_url, year, distributor, media_type)",
    )
    .eq("curated_list_id", list.id)
    .order("position");
  const titleRows = (rows ?? []) as unknown as TitleJoin[];

  // films vs series — derived from the matched titles' media_type.
  const mediaTypes = titleRows
    .map((r) => r.titles?.media_type)
    .filter((m): m is string => !!m);
  const noun =
    mediaTypes.length > 0 && mediaTypes.every((m) => m === "tv")
      ? "series"
      : "films";
  const itemCount = titleRows.filter((r) => r.titles).length;

  // Position slots 1..maxPosition. Matched titles fill their slot;
  // gaps (unmatched-catalog positions) render as explicit
  // placeholders so the ranking stays honest rather than collapsing.
  const maxPosition = titleRows.reduce(
    (m, r) => Math.max(m, r.position),
    0,
  );
  const byPosition = new Map<number, BuilderTitle>();
  for (const r of titleRows) {
    if (!r.titles) continue;
    byPosition.set(r.position, {
      id: r.titles.id,
      slug: r.titles.slug,
      title: r.titles.title,
      poster_url: r.titles.poster_url,
      year: r.titles.year,
      distributor: r.titles.distributor,
    });
  }
  const slots: ListSlot[] = [];
  for (let p = 1; p <= maxPosition; p++) {
    slots.push({ position: p, title: byPosition.get(p) ?? null });
  }

  // Viewer's current Top 12 — drives isAdded / atCapacity on cards.
  const user = await getUser();
  const isAuthed = !!user;
  let initialPickedIds: string[] = [];
  let initialPickCount = 0;
  if (user) {
    const picks = await getTopTitlesForUser(user.id);
    initialPickedIds = picks.map((p) => p.title_id);
    initialPickCount = picks.length;
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            {list.name}
          </h1>
          {list.description && (
            <p className="m-0 max-w-2xl text-body text-moonbeem-ink-muted leading-relaxed">
              {list.description as string}
            </p>
          )}
          <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
            {itemCount} {noun}
          </p>
        </header>

        <ListPageClient
          listSlug={slug}
          slots={slots}
          isAuthed={isAuthed}
          initialPickedIds={initialPickedIds}
          initialPickCount={initialPickCount}
        />
      </div>
    </div>
  );
}

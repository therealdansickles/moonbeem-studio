// /lists/featured — dedicated page for the editorially Featured set
// (titles.is_featured, ordered by featured_order). Not curated_lists-
// backed — it's a generated view — so this is a static route that
// queries directly and shares ListPageLayout with the [slug] pages.

import type { Metadata } from "next";
import { getFeaturedTitles } from "@/lib/queries/titles";
import ListPageLayout from "../ListPageLayout";
import type { ListSlot } from "../ListPageClient";

export const metadata: Metadata = {
  title: "Featured · Moonbeem",
  description:
    "Featured titles on Moonbeem — the editorial picks. Add them to your own top 12.",
  openGraph: {
    title: "Featured · Moonbeem",
    description: "Featured titles on Moonbeem — the editorial picks.",
    type: "website",
  },
};

export default async function FeaturedListPage() {
  const featured = await getFeaturedTitles();
  const slots: ListSlot[] = featured.map((t, i) => ({
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
      name="Featured"
      description={null}
      itemCount={slots.length}
      noun="films"
      slots={slots}
      pagePath="/lists/featured"
    />
  );
}

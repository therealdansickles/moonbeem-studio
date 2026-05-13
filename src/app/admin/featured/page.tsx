// /admin/featured — super-admin curation of the homepage Featured
// carousel. Three operations live on this page:
//   1. Reorder via drag-and-drop (persists to titles.featured_order)
//   2. Remove via per-row X (PATCH is_featured=false; row stays in DB
//      with its featured_order untouched but drops out of the homepage)
//   3. Add via inline search (PATCH is_featured=true; appended to end
//      with the next-available featured_order)
//
// The Featured carousel on the homepage reads getFeaturedTitles()
// ordered by featured_order ASC; both mutation paths revalidatePath('/')
// so the carousel reflects changes on the next visit.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import FeaturedCurator, { type FeaturedTitle } from "./FeaturedCurator";

export const metadata: Metadata = {
  title: "Featured curation · Moonbeem admin",
  robots: { index: false, follow: false },
};

export default async function AdminFeaturedPage() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("titles")
    .select("id, slug, title, year, poster_url, featured_order")
    .eq("is_featured", true)
    .order("featured_order", { ascending: true });

  const titles: FeaturedTitle[] = error
    ? []
    : ((data ?? []) as FeaturedTitle[]);

  return (
    <div className="min-h-screen bg-moonbeem-black px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Featured curation
          </h1>
          <Link
            href="/admin"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to admin
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate the homepage Featured carousel. Drag to reorder; X to
          unfeature. Add another title using the search at the bottom.
        </p>
        {error && (
          <p className="text-body-sm text-moonbeem-magenta">
            Failed to load featured titles: {error.message}
          </p>
        )}
        <FeaturedCurator initialTitles={titles} />
      </div>
    </div>
  );
}

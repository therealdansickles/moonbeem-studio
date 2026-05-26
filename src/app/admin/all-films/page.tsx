// /admin/all-films — super-admin curation of the homepage All Films
// carousel. Mirrors /admin/recent-edits's three-section shape
// (Pinned / Hidden / Candidates) but on titles. All Films is an
// "everything" carousel (no LIMIT on the homepage query), so pinning
// promotes a small set to the top and hiding removes from the
// section only — Featured / partner pages still surface the title.
//
// The carousel on the homepage reads getAllFilms(), now ordered by
// allfilms_pin_order ASC NULLS LAST then created_at DESC, filtered
// to is_hidden_from_all_films=false. Mutation calls
// revalidatePath('/') so the carousel reflects changes on the next
// visit.

import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import AllFilmsCurator, {
  type AllFilmsCurationItem,
} from "./AllFilmsCurator";

export const metadata: Metadata = {
  title: "All Films curation · Moonbeem admin",
  robots: { index: false, follow: false },
};

type TitleRow = {
  id: string;
  slug: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  created_at: string;
  allfilms_pin_order: number | null;
  is_hidden_from_all_films: boolean;
};

// Bounded candidate pool. Catalog today is ~11 active movies; the
// 100-row ceiling matches Recent for consistency and easily covers
// near-future catalog growth.
const CANDIDATE_POOL_LIMIT = 100;

const TITLE_SELECT =
  "id, slug, title, year, poster_url, created_at, allfilms_pin_order, is_hidden_from_all_films";

function mapRow(r: TitleRow): AllFilmsCurationItem {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    year: r.year,
    poster_url: r.poster_url,
    created_at: r.created_at,
    allfilms_pin_order: r.allfilms_pin_order,
    is_hidden_from_all_films: r.is_hidden_from_all_films,
  };
}

export default async function AdminAllFilmsPage() {
  await requireSuperAdminOr404();
  const supabase = createServiceRoleClient();

  // Single canonical gate on every list — is_public + is_active +
  // media_type='movie'. We sort client-side into pinned / hidden /
  // candidate buckets so the admin only sees rows the homepage
  // would consider.
  const { data: pinnedRaw } = await supabase
    .from("titles")
    .select(TITLE_SELECT)
    .eq("is_public", true)
    .eq("is_active", true)
    .eq("media_type", "movie")
    .not("allfilms_pin_order", "is", null)
    .order("allfilms_pin_order", { ascending: true });

  const { data: hiddenRaw } = await supabase
    .from("titles")
    .select(TITLE_SELECT)
    .eq("is_public", true)
    .eq("is_active", true)
    .eq("media_type", "movie")
    .eq("is_hidden_from_all_films", true)
    .order("created_at", { ascending: false });

  const { data: candidatesRaw } = await supabase
    .from("titles")
    .select(TITLE_SELECT)
    .eq("is_public", true)
    .eq("is_active", true)
    .eq("media_type", "movie")
    .is("allfilms_pin_order", null)
    .eq("is_hidden_from_all_films", false)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_POOL_LIMIT);

  const pinned = ((pinnedRaw ?? []) as TitleRow[]).map(mapRow);
  const hidden = ((hiddenRaw ?? []) as TitleRow[]).map(mapRow);
  const candidates = ((candidatesRaw ?? []) as TitleRow[]).map(mapRow);

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            All Films curation
          </h1>
          <Link
            href="/admin/homepage"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
          >
            ← Back to homepage curation
          </Link>
        </div>
        <p className="text-body text-moonbeem-ink-muted m-0">
          Curate the homepage All Films carousel. Drag pinned rows to
          reorder; X to unpin; Hide to remove from this carousel only
          (Featured / partner pages still surface the title). Search
          the candidate pool below to find more films to pin or hide.
        </p>
        <AllFilmsCurator
          initialPinned={pinned}
          initialHidden={hidden}
          initialCandidates={candidates}
        />
      </div>
    </div>
  );
}

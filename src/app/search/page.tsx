import type { Metadata } from "next";
import TitleCard from "@/components/TitleCard";
import { searchTitles } from "@/lib/queries/titles";

type PageProps = {
  searchParams: Promise<{ q?: string }>;
};

export async function generateMetadata({
  searchParams,
}: PageProps): Promise<Metadata> {
  const { q } = await searchParams;
  const trimmed = (q ?? "").trim();
  return {
    title: trimmed ? `Search: ${trimmed} · Moonbeem` : "Search · Moonbeem",
  };
}

export default async function SearchPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const results = query.length >= 2 ? await searchTitles(query, 60) : [];

  return (
    <div className="flex-1 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] py-12">
      <div className="mx-auto max-w-7xl px-6">
        {!query ? (
          <div className="flex flex-col gap-3">
            <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
              Search
            </h1>
            <p className="text-body text-moonbeem-ink-muted">
              Search for any film in our catalog of 86,000+ titles.
            </p>
          </div>
        ) : (
          <>
            <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
              Results for &lsquo;{query}&rsquo;
            </h1>
            <p className="mt-2 text-body-sm text-moonbeem-ink-muted">
              {results.length === 0
                ? `No films match '${query}'. Try a different search.`
                : `${results.length} ${results.length === 1 ? "film" : "films"}`}
            </p>

            {results.length > 0 && (
              <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {results.map((r) => (
                  <TitleCard
                    key={r.id}
                    title={{
                      id: r.id,
                      slug: r.slug,
                      title: r.title,
                      poster_url: r.poster_url,
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

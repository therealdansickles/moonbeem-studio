import {
  getAllFilms,
  getFeaturedTitles,
  getRecentFanEdits,
  getTrendingFanEdits,
} from "@/lib/queries/titles";
import { getMarqueePartners } from "@/lib/queries/partners";
import {
  getHomepageSectionOrder,
  type HomepageSectionSlug,
} from "@/lib/homepage-sections";
import TitleCarousel from "@/components/TitleCarousel";
import FanEditCarousel from "@/components/FanEditCarousel";
import PartnerLogoStrip from "@/components/PartnerLogoStrip";

export default async function Home() {
  // Fetch every section's data + the configured section order in
  // parallel. Each carousel is a separate query (already the case
  // pre-slice-D); we just add one more for the order config.
  const [order, featured, recentFanEdits, partners, allFilms, trending] =
    await Promise.all([
      getHomepageSectionOrder(),
      getFeaturedTitles(),
      getRecentFanEdits(12),
      getMarqueePartners(),
      getAllFilms(),
      getTrendingFanEdits(12),
    ]);

  // Renderer-per-slug — keeps the conditional length>0 guard
  // co-located with each section. Returning null means "the section
  // is configured but has no data" — it drops out of the rendered
  // layout entirely (and out of the last-section bottom-padding
  // calculation below).
  const renderers: Record<HomepageSectionSlug, () => React.ReactNode> = {
    marquee: () => <PartnerLogoStrip partners={partners} />,
    featured: () => (
      <TitleCarousel title="Featured Films" titles={featured} />
    ),
    trending: () =>
      trending.length > 0 ? (
        <FanEditCarousel title="Trending Edits" fanEdits={trending} />
      ) : null,
    recent: () =>
      recentFanEdits.length > 0 ? (
        <FanEditCarousel title="Recent Edits" fanEdits={recentFanEdits} />
      ) : null,
    "all-films": () =>
      allFilms.length > 0 ? (
        <TitleCarousel title="All Films" titles={allFilms} />
      ) : null,
  };

  // Compute each section's rendered node ONCE, then determine the
  // index of the last visibly-rendered section so we can apply the
  // larger bottom padding (pb-20) there instead of pb-10. This used
  // to be hardcoded to "All Films" pre-slice-D; under arbitrary
  // reorder it's whichever section ends up rendered last.
  const rendered: Array<{ slug: HomepageSectionSlug; node: React.ReactNode }> =
    order.map((slug) => ({ slug, node: renderers[slug]() }));
  const visibleIndexes = rendered
    .map((r, i) => (r.node ? i : -1))
    .filter((i) => i >= 0);
  const lastVisibleIndex = visibleIndexes.length > 0
    ? visibleIndexes[visibleIndexes.length - 1]
    : -1;

  return (
    <div className="relative flex flex-col items-stretch flex-1">
      <div className="flex items-center justify-center overflow-hidden px-4 pt-8 pb-6 md:pt-12 md:pb-4">
        {/* Fluid wordmark: clamps from 2.5rem (40px, smallest mobile)
            up to 6rem (96px, matches the design-system
            --text-display-xl on desktop). 12vw is the preferred
            scaling band — keeps the wordmark visually large
            without overflowing on any viewport ≥320px. */}
        <h1 className="font-wordmark font-bold text-moonbeem-pink m-0 text-[clamp(2.5rem,12vw,6rem)] leading-[0.95]">
          moonbeem.
        </h1>
      </div>

      {rendered.map((r, i) => {
        if (!r.node) return null;
        const isLast = i === lastVisibleIndex;
        // Marquee has its own visual rhythm — pre-slice-D it used
        // pb-6 (logo strip is lighter visually than a poster carousel
        // and doesn't need the same gap below). Preserve that here.
        const className =
          r.slug === "marquee" && !isLast
            ? "w-full pb-6"
            : isLast
              ? "w-full pb-20"
              : "w-full pb-10";
        return (
          <div key={r.slug} className={className}>
            {r.node}
          </div>
        );
      })}
    </div>
  );
}

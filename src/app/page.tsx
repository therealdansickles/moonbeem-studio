import {
  getAllFilms,
  getEventTitles,
  getFeaturedTitles,
  getRecentFanEdits,
  getSeriesTitles,
  getTitlesWithActiveCampaigns,
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
  const [
    order,
    featured,
    recentFanEdits,
    partners,
    allFilms,
    trending,
    activeCampaignTitles,
    series,
    events,
  ] = await Promise.all([
    getHomepageSectionOrder(),
    getFeaturedTitles(),
    getRecentFanEdits(12),
    getMarqueePartners(),
    getAllFilms(),
    getTrendingFanEdits(12),
    getTitlesWithActiveCampaigns(),
    getSeriesTitles(),
    getEventTitles(),
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
    "active-campaigns": () =>
      activeCampaignTitles.length > 0 ? (
        <TitleCarousel
          title="Active Fan Edit Campaigns"
          titles={activeCampaignTitles.map((t) => ({
            id: t.id,
            slug: t.slug,
            title: t.title,
            poster_url: t.poster_url,
            cpmDisplay: t.cpm_display,
          }))}
        />
      ) : null,
  };

  // Compute each section's rendered node ONCE, then determine the
  // index of the last visibly-rendered section so we can apply the
  // larger bottom padding (pb-20) there instead of pb-10. This used
  // to be hardcoded to "All Films" pre-slice-D; under arbitrary
  // reorder it's whichever section ends up rendered last.
  const rendered: Array<{ slug: string; node: React.ReactNode }> =
    order.map((slug) => ({ slug, node: renderers[slug]() }));
  // Series rail — a fixed shelf rendered immediately after All Films.
  // NOT a homepage_sections slug: keeping it out of the orderable
  // taxonomy avoids touching the section CHECK constraint, the admin
  // reorder route, and a migration. Splices right after the all-films
  // node (falls back to the end if all-films isn't in the configured
  // order). Guarded on empty so there's no "Series" header on an
  // empty shelf (TitleCarousel also no-ops on an empty list).
  if (series.length > 0) {
    const seriesEntry = {
      slug: "series",
      node: <TitleCarousel title="Series" titles={series} />,
    };
    const afterAllFilms = rendered.findIndex((r) => r.slug === "all-films");
    if (afterAllFilms >= 0) {
      rendered.splice(afterAllFilms + 1, 0, seriesEntry);
    } else {
      rendered.push(seriesEntry);
    }
  }
  // Events rail — clones the Series shelf for event-as-title content
  // (media_type='event', e.g. Sukeban matches). Same out-of-taxonomy
  // approach as Series (no homepage_sections slug, so no CHECK / reorder
  // route / migration to touch). Splices AFTER the Series node when
  // present, else after all-films, else pushes — yielding the order
  // All Films → Series → Events. Runs after the Series splice above so
  // the "series" node already exists in `rendered`. Guarded on empty so
  // there's no "Events" header on an empty shelf.
  if (events.length > 0) {
    const eventsEntry = {
      slug: "events",
      node: <TitleCarousel title="Events" titles={events} />,
    };
    const afterSeries = rendered.findIndex((r) => r.slug === "series");
    const afterAllFilmsForEvents = rendered.findIndex(
      (r) => r.slug === "all-films",
    );
    if (afterSeries >= 0) {
      rendered.splice(afterSeries + 1, 0, eventsEntry);
    } else if (afterAllFilmsForEvents >= 0) {
      rendered.splice(afterAllFilmsForEvents + 1, 0, eventsEntry);
    } else {
      rendered.push(eventsEntry);
    }
  }
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
        <div className="flex flex-col items-center">
          <h1 className="font-wordmark font-bold text-moonbeem-pink m-0 text-[clamp(2.5rem,12vw,6rem)] leading-[0.95]">
            moonbeem.
          </h1>
          <p className="text-heading-sm font-medium tracking-wide text-moonbeem-ink text-center m-0 mt-3">
            Watch<span className="text-moonbeem-pink">.</span> Share<span className="text-moonbeem-pink">.</span> Earn<span className="text-moonbeem-pink">.</span>
          </p>
        </div>
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

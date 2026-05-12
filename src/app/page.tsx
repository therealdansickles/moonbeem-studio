import {
  getAllFilms,
  getFeaturedTitles,
  getRecentFanEdits,
} from "@/lib/queries/titles";
import { getMarqueePartners } from "@/lib/queries/partners";
import TitleCarousel from "@/components/TitleCarousel";
import FanEditCarousel from "@/components/FanEditCarousel";
import PartnerLogoStrip from "@/components/PartnerLogoStrip";

export default async function Home() {
  const [featured, recentFanEdits, partners, allFilms] = await Promise.all([
    getFeaturedTitles(),
    getRecentFanEdits(12),
    getMarqueePartners(),
    getAllFilms(),
  ]);

  return (
    <div className="relative flex flex-col items-stretch bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] flex-1">
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

      <div className="w-full pb-6">
        <PartnerLogoStrip partners={partners} />
      </div>

      <div className="w-full pb-10">
        <TitleCarousel title="Featured" titles={featured} />
      </div>

      {recentFanEdits.length > 0 && (
        <div className="w-full pb-10">
          <FanEditCarousel title="Recent Remixes" fanEdits={recentFanEdits} />
        </div>
      )}

      {allFilms.length > 0 && (
        <div className="w-full pb-20">
          <TitleCarousel title="All Films" titles={allFilms} />
        </div>
      )}
    </div>
  );
}

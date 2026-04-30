import { getFeaturedTitles } from "@/lib/queries/titles";
import TitleCarousel from "@/components/TitleCarousel";

export default async function Home() {
  const featured = await getFeaturedTitles();

  return (
    <div className="relative flex flex-col items-center bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)] flex-1">
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-6">
        <h1 className="font-wordmark font-bold text-display-xl text-moonbeem-pink m-0">
          moonbeem.
        </h1>
      </div>

      <div className="w-full pb-20">
        <TitleCarousel title="Featured" titles={featured} />
      </div>
    </div>
  );
}

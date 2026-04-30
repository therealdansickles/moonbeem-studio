import Link from "next/link";
import { getUser } from "@/lib/dal";
import { getFeaturedTitles } from "@/lib/queries/titles";
import TitleCarousel from "@/components/TitleCarousel";

export default async function Home() {
  const [user, featured] = await Promise.all([getUser(), getFeaturedTitles()]);
  const navHref = user ? "/me" : "/login";
  const navLabel = user ? "Account →" : "Sign in →";

  return (
    <div className="relative min-h-screen flex flex-col items-center bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <Link
        href={navHref}
        className="absolute top-6 right-6 z-10 text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink transition-colors px-2 py-1"
      >
        {navLabel}
      </Link>

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

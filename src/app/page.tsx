import Link from "next/link";
import { getUser } from "@/lib/dal";

export default async function Home() {
  const user = await getUser();
  const navHref = user ? "/me" : "/login";
  const navLabel = user ? "Account →" : "Sign in →";

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <Link
        href={navHref}
        className="absolute top-6 right-6 text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink transition-colors px-2 py-1"
      >
        {navLabel}
      </Link>
      <h1 className="font-wordmark font-bold text-display-xl text-moonbeem-pink m-0">
        moonbeem.
      </h1>
    </div>
  );
}

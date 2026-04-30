import Image from "next/image";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/dal";
import AccountMenu from "./AccountMenu";
import SearchBar from "./SearchBar";

export default async function TopNav() {
  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-white/5 bg-moonbeem-black/80 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-7xl items-center gap-4 px-4 md:gap-6 md:px-6">
        <Link
          href="/"
          aria-label="Moonbeem home"
          className="flex shrink-0 items-center"
        >
          <Image
            src="/moonbeem-logo.png"
            alt="moonbeem"
            width={40}
            height={40}
            priority
            className="h-10 w-auto"
          />
        </Link>

        <nav className="hidden items-center gap-4 md:flex">
          <Link
            href="/browse"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
          >
            Browse
          </Link>
          {profile && (
            <Link
              href="/me"
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
            >
              For You
            </Link>
          )}
          {isSuperAdmin && (
            <Link
              href="/admin/titles/erupcja/upload"
              className="text-body-sm text-moonbeem-lime hover:opacity-80 transition-opacity"
            >
              Admin
            </Link>
          )}
        </nav>

        <div className="flex flex-1 justify-end">
          <SearchBar />
        </div>

        <div className="flex shrink-0 items-center">
          {profile ? (
            <AccountMenu
              email={profile.email}
              handle={profile.handle}
              displayName={profile.displayName}
              avatarUrl={profile.avatarUrl}
            />
          ) : (
            <Link
              href="/login"
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink transition-colors"
            >
              Sign in →
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

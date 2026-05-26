import Image from "next/image";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/dal";
import AccountMenu from "./AccountMenu";
import MobileNavMenu from "./MobileNavMenu";
import AdminNavDropdown from "./AdminNavDropdown";
import SearchBar from "./SearchBar";

export default async function TopNav() {
  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";
  const memberships = profile?.partnerMemberships ?? [];
  // Unified "Admin" dropdown — visible when the user is super_admin
  // OR has at least one partner membership. One nav slot for every
  // role combination; the dropdown's contents differ but the trigger
  // is always the same.
  const showAdminDropdown = isSuperAdmin || memberships.length > 0;

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-white/5 bg-moonbeem-black/80 backdrop-blur-md">
      <div className="flex h-full w-full items-center gap-4 px-6 md:gap-6">
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

        {/* Hamburger trigger + slide-down panel. Renders the
            corresponding nav links on mobile (md:hidden on the
            trigger; the panel is only opened on mobile). Auth
            booleans are computed once above and passed in — no
            second admin check. */}
        <MobileNavMenu
          showForYou={!!profile}
          isSuperAdmin={isSuperAdmin}
          memberships={memberships}
        />

        <nav className="hidden items-center gap-4 md:flex">
          <Link
            href="/browse"
            className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
          >
            Browse
          </Link>
          {profile && (
            <Link
              href="/for-you"
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
            >
              For You
            </Link>
          )}
          {showAdminDropdown && (
            <AdminNavDropdown
              isSuperAdmin={isSuperAdmin}
              memberships={memberships}
            />
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

import Image from "next/image";
import Link from "next/link";
import { getCurrentProfile } from "@/lib/dal";
import AccountMenu from "./AccountMenu";
import MobileNavMenu from "./MobileNavMenu";
import PartnersNavDropdown from "./PartnersNavDropdown";
import SearchBar from "./SearchBar";

export default async function TopNav() {
  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";
  const memberships = profile?.partnerMemberships ?? [];
  // UX rules per spec:
  //   0 memberships → render nothing extra (existing state).
  //   1 membership  → a single inline link "<Partner> dashboard".
  //   2+            → "Your partners ▾" dropdown.
  const singleMembership = memberships.length === 1 ? memberships[0] : null;
  const showPartnersDropdown = memberships.length >= 2;

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
        <MobileNavMenu showForYou={!!profile} showAdmin={isSuperAdmin} />

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
          {singleMembership && (
            <Link
              href={`/p/${singleMembership.partner_slug}/dashboard`}
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-ink transition-colors"
            >
              {singleMembership.partner_name} dashboard
            </Link>
          )}
          {showPartnersDropdown && (
            <PartnersNavDropdown memberships={memberships} />
          )}
          {isSuperAdmin && (
            <Link
              href="/admin"
              className="text-body-sm text-moonbeem-pink hover:opacity-80 transition-opacity"
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
              partnerMemberships={memberships}
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

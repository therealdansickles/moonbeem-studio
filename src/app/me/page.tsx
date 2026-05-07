import Image from "next/image";
import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { SignOutButton } from "@/components/SignOutButton";
import PlatformIcon from "@/components/PlatformIcon";

type SocialPlatform = "tiktok" | "instagram" | "twitter" | "youtube";

const platformLabel: Record<SocialPlatform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X",
  youtube: "YouTube",
};

export default async function MePage() {
  const session = await verifySession();

  const service = createServiceRoleClient();

  // user profile (handle, display_name, bio, avatar)
  const { data: userRow } = await service
    .from("users")
    .select("handle, display_name, bio, avatar_url")
    .eq("id", session.userId)
    .maybeSingle();

  // creator + verified socials
  const { data: creator } = await service
    .from("creators")
    .select("id")
    .eq("user_id", session.userId)
    .is("deleted_at", null)
    .maybeSingle();
  const { data: socials } = creator
    ? await service
      .from("creator_socials")
      .select("platform, handle, verified_at")
      .eq("creator_id", creator.id)
      .not("verified_at", "is", null)
    : { data: [] };

  // claimed status: if user has no handle, prompt to claim
  const handle = (userRow?.handle as string | null) ?? null;
  if (!handle) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
        <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
          moonbeem.
        </h1>
        <p className="text-body text-moonbeem-ink-muted text-center max-w-md">
          Claim your Moonbeem handle to start verifying socials and
          attributing fan edits.
        </p>
        <Link
          href="/onboarding/handle"
          className="rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy hover:opacity-90"
        >
          Claim your handle
        </Link>
        <SignOutButton />
      </div>
    );
  }

  const displayName = (userRow?.display_name as string | null) ?? null;
  const bio = (userRow?.bio as string | null) ?? null;
  const avatarUrl = (userRow?.avatar_url as string | null) ?? null;
  const verifiedSocials =
    (socials ?? []) as Array<{ platform: SocialPlatform; handle: string }>;

  return (
    <div className="min-h-screen px-6 py-12 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <div className="mx-auto flex max-w-2xl flex-col gap-10">
        {/* Profile header */}
        <header className="flex flex-col items-center gap-4 text-center">
          <div className="relative h-24 w-24 overflow-hidden rounded-full bg-moonbeem-navy/40">
            {avatarUrl
              ? (
                <Image
                  src={avatarUrl}
                  alt=""
                  fill
                  sizes="96px"
                  className="object-cover"
                  unoptimized
                />
              )
              : (
                <div className="flex h-full w-full items-center justify-center font-wordmark text-display-md text-moonbeem-violet-soft">
                  {handle[0]?.toUpperCase() ?? "?"}
                </div>
              )}
          </div>
          <div className="flex flex-col items-center gap-1">
            {displayName && (
              <p className="text-heading-md font-medium text-moonbeem-ink m-0">
                {displayName}
              </p>
            )}
            <p className="text-body text-moonbeem-pink m-0">@{handle}</p>
          </div>
          {bio && (
            <p className="text-body-sm text-moonbeem-ink-muted max-w-prose m-0">
              {bio}
            </p>
          )}
          <Link
            href="/me/edit"
            className="rounded-md border border-white/15 px-3 py-1.5 text-caption text-moonbeem-ink-muted hover:border-moonbeem-pink hover:text-moonbeem-ink"
          >
            Edit profile
          </Link>
        </header>

        {/* Verified socials (read-only display) */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Verified accounts
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            {verifiedSocials.length === 0
              ? (
                <p className="text-body-sm text-moonbeem-ink-subtle">
                  No verified accounts yet.{" "}
                  <Link
                    href="/me/edit"
                    className="text-moonbeem-pink hover:underline"
                  >
                    Verify your socials
                  </Link>
                  {" "}to claim attribution.
                </p>
              )
              : (
                <ul className="flex flex-wrap gap-2">
                  {verifiedSocials.map((s) => (
                    <li
                      key={`${s.platform}-${s.handle}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-body-sm text-moonbeem-ink"
                    >
                      <PlatformIcon platform={s.platform} className="h-3 w-3" />
                      <span>@{s.handle}</span>
                      <span className="text-emerald-300" aria-hidden="true">
                        ✓
                      </span>
                      <span className="sr-only">verified</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </section>

        {/* My fan edits — placeholder until we have real data here */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            My fan edits
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="text-body-sm text-moonbeem-ink-subtle">
              Fan edits attributed to your verified handles will appear here.
            </p>
          </div>
        </section>

        {/* Recent activity — placeholder for now */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Recent activity
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="text-body-sm text-moonbeem-ink-subtle">
              Nothing yet. We'll surface plays, modal opens, and edits here
              as they happen.
            </p>
          </div>
        </section>

        <div className="mt-4 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}

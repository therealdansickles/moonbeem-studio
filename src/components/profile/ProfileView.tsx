import Link from "next/link";
import type { Profile, TopTitle } from "@/lib/queries/profiles";
import AvatarCircle from "./AvatarCircle";
import Top12Grid from "./Top12Grid";

type Props = {
  profile: Profile | null;
  handle: string;
  topTitles: TopTitle[];
  isOwner: boolean;
};

export default function ProfileView({
  profile,
  handle,
  topTitles,
  isOwner,
}: Props) {
  if (!profile) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-6 py-24 text-center">
        <p className="font-wordmark text-display-sm text-moonbeem-pink">
          @{handle}
        </p>
        <p className="mt-6 text-body-lg text-moonbeem-ink-muted">
          This handle isn&apos;t claimed yet.
        </p>
        <p className="mt-2 text-body-sm text-moonbeem-ink-subtle">
          If you&apos;re @{handle}, sign up to claim it.
        </p>
        <Link
          href="/login"
          className="mt-8 rounded-md bg-moonbeem-pink px-5 py-3 text-body font-semibold text-moonbeem-navy transition-opacity hover:opacity-90"
        >
          Sign up
        </Link>
      </div>
    );
  }

  const displayName = profile.display_name ?? profile.handle;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-6 py-10">
      <header className="relative flex flex-col gap-6 sm:flex-row sm:items-start">
        <AvatarCircle
          avatarUrl={profile.avatar_url}
          displayName={profile.display_name}
          handle={profile.handle}
          size={96}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h1 className="font-wordmark text-heading-lg text-moonbeem-ink m-0 break-words">
            {displayName}
          </h1>
          <p className="text-body-sm text-moonbeem-ink-subtle">
            @{profile.handle}
          </p>
          {profile.bio && (
            <p className="mt-3 text-body text-moonbeem-ink whitespace-pre-line line-clamp-3">
              {profile.bio}
            </p>
          )}
          {profile.links.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {profile.links.map((link, i) => (
                <li key={i}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                  >
                    {link.label} <span aria-hidden>→</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        {isOwner && (
          <Link
            href="/me/edit"
            className="self-start rounded-md border border-white/15 bg-white/5 px-4 py-2 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Edit profile
          </Link>
        )}
      </header>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-lime uppercase m-0">
            Top 12
          </h2>
        </div>
        <Top12Grid topTitles={topTitles} isOwner={isOwner} />
      </section>
    </div>
  );
}

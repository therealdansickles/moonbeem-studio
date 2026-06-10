import Link from "next/link";
import type { Profile, TopTitle } from "@/lib/queries/profiles";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import {
  PLATFORM_LABEL,
  buildSocialProfileUrl,
} from "@/lib/socials/profile-url";
import PlatformIcon from "@/components/PlatformIcon";
import AvatarCircle from "./AvatarCircle";
import Top12Grid from "./Top12Grid";
import ProfileFanEditCard from "./ProfileFanEditCard";
import DiaryRow from "@/components/diary/DiaryRow";
import type { DiaryEntry } from "@/lib/queries/diary";

type Props = {
  profile: Profile | null;
  handle: string;
  topTitles: TopTitle[];
  diary: DiaryEntry[];
  fanEdits: FanEditWithTitle[];
  isOwner: boolean;
};

export default function ProfileView({
  profile,
  handle,
  topTitles,
  diary,
  fanEdits,
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
      <header className="relative flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <AvatarCircle
          avatarUrl={profile.avatar_url}
          displayName={profile.display_name}
          handle={profile.handle}
          size={96}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <h1 className="font-wordmark text-heading-lg text-moonbeem-ink m-0 break-words">
            {displayName}
          </h1>
          <p className="m-0 mt-0.5 text-body-sm text-moonbeem-ink-subtle">
            @{profile.handle}
          </p>
          {/* Bio + verified socials + other-links: one governed
              rhythm. mt-4 separates the group from the name/handle
              pair; space-y-4 keeps the three items on a uniform
              16px cadence regardless of which are present. */}
          <div className="mt-4 space-y-4">
            {profile.bio && (
              <p className="text-body text-moonbeem-ink whitespace-pre-line line-clamp-3">
                {profile.bio}
              </p>
            )}
            {profile.verified_socials.length > 0 && (
              <ul className="flex flex-wrap justify-center gap-2 sm:justify-start">
                {profile.verified_socials.map((s) => (
                  <li key={s.platform}>
                    <a
                      href={buildSocialProfileUrl(s.platform, s.handle)}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="group inline-flex items-center gap-2 rounded-full border border-moonbeem-pink/30 bg-moonbeem-pink/10 px-3 py-1 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                      title={`Verified on ${PLATFORM_LABEL[s.platform]}`}
                    >
                      <PlatformIcon
                        platform={s.platform}
                        className="h-4 w-4 text-moonbeem-pink"
                      />
                      <span>@{s.handle}</span>
                      <span
                        aria-label="Verified"
                        className="text-emerald-300"
                      >
                        ✓
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {profile.links.length > 0 && (
              <div>
                <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-ink-subtle uppercase m-0">
                  Other links
                </h2>
                <ul className="mt-2 flex flex-wrap justify-center gap-2 sm:justify-start">
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
              </div>
            )}
          </div>
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

      {/* Block 3.1: owner-only Add-fan-edit button. Sits above the
          Top 12 so it's in the natural reading flow from header →
          first action. Matches the Edit profile button's visual
          register — same rounded outlined treatment, no pink fill. */}
      {isOwner && (
        <div className="flex justify-center sm:justify-start">
          <Link
            href={`/c/${handle}/upload`}
            className="rounded-md border border-white/15 bg-white/5 px-4 py-2 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
          >
            Add fan edit
          </Link>
        </div>
      )}

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
            Top 12
          </h2>
        </div>
        {/* /c/[handle] is a pure viewing surface — Top 12 management
            (add, remove, reorder) lives on /me/top-12. The grid always
            renders read-only here, even for the profile owner. */}
        <Top12Grid topTitles={topTitles} isOwner={false} />
      </section>

      {/* Diary — public watch-log entries, newest first. Sits between Top 12
          and Fan edits; omitted when empty (same discipline as Fan edits). */}
      {diary.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
              Diary
            </h2>
          </div>
          <div className="flex flex-col gap-3">
            {diary.map((e) => (
              <DiaryRow key={e.id} entry={e} />
            ))}
          </div>
        </section>
      )}

      {/* Fan edits attributed to this creator. Omitted entirely when
          empty — strangers viewing the profile don't need the
          empty-state coaching that /me carries. */}
      {fanEdits.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
              Fan edits
            </h2>
          </div>
          <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {fanEdits.map((fe, i) => (
              <ProfileFanEditCard key={fe.id} fanEdit={fe} eager={i < 4} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

import Link from "next/link";
import type { Profile, TopTitle } from "@/lib/queries/profiles";
import type { FanEditWithTitle } from "@/lib/queries/titles";
import {
  PLATFORM_LABEL,
  buildSocialProfileUrl,
} from "@/lib/socials/profile-url";
import PlatformIcon from "@/components/PlatformIcon";
import AvatarCircle from "./AvatarCircle";
import FollowButton from "./FollowButton";
import TipButton from "./TipButton";
import FollowStatLinks from "./FollowStatLinks";
import type { FollowState } from "@/lib/follows/server";
import Top12Grid from "./Top12Grid";
import ProfileFanEditCard from "./ProfileFanEditCard";
import DiaryRow from "@/components/diary/DiaryRow";
import type { DiaryEntry } from "@/lib/queries/diary";
import ListCard from "@/components/lists/ListCard";
import type { PublicListSummary } from "@/lib/queries/lists";

// CF-4: how many fan-edit cards show before the "View all" expansion. The
// array reaching here is already capped at 24 by getFanEditsForCreator —
// this is a display-layer preview cap on top of that.
const FAN_EDITS_PREVIEW_COUNT = 6;

type Props = {
  profile: Profile | null;
  handle: string;
  topTitles: TopTitle[];
  diary: DiaryEntry[];
  lists: PublicListSummary[];
  fanEdits: FanEditWithTitle[];
  watchedCount: number;
  isOwner: boolean;
  followState: FollowState;
  isFollowing: boolean;
};

export default function ProfileView({
  profile,
  handle,
  topTitles,
  diary,
  lists,
  fanEdits,
  watchedCount,
  isOwner,
  followState,
  isFollowing,
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
  const hasAnyContent =
    topTitles.length > 0 ||
    fanEdits.length > 0 ||
    diary.length > 0 ||
    lists.length > 0;

  // CF-4: owner-only controls — isOwner-gated and visually secondary (quiet
  // outlined chips), grouped at the top-right of the identity block.
  const ownerControls = isOwner ? (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 sm:justify-start">
      <Link
        href="/me/edit"
        className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
      >
        Edit profile
      </Link>
      <Link
        href={`/c/${handle}/upload`}
        className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
      >
        Add fan edit
      </Link>
    </div>
  ) : null;

  // Header-right slot: owner sees their controls + a STATIC follower/following
  // byline (no button — own-profile hiding is decided here, server-side, by not
  // rendering the FollowButton island at all). Everyone else gets the
  // interactive FollowButton, which carries its own optimistic stat line.
  const headerActions = isOwner ? (
    <div className="flex shrink-0 flex-col items-center gap-1.5 sm:items-end">
      {ownerControls}
      <FollowStatLinks
        followers={profile.follower_count}
        following={profile.following_count}
        handle={profile.handle}
      />
    </div>
  ) : (
    <div className="flex shrink-0 flex-col items-center gap-3 sm:items-end">
      <FollowButton
        targetCreatorId={profile.creator_id}
        handle={profile.handle}
        initialIsFollowing={isFollowing}
        initialFollowerCount={profile.follower_count}
        followingCount={profile.following_count}
        followState={followState}
        returnTo={`/c/${profile.handle}`}
      />
      <TipButton creatorId={profile.creator_id} creatorName={displayName} />
    </div>
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-6 py-10">
      {/* HEADER (CF-4) — editorial identity block. Avatar left, identity
          stack right on sm+. Verified socials are elevated directly under the
          name as the legitimacy signal, ahead of the bio. */}
      <header className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <AvatarCircle
          avatarUrl={profile.avatar_url}
          displayName={profile.display_name}
          handle={profile.handle}
          size={112}
          className="shrink-0"
        />
        <div className="min-w-0 flex-1 text-center sm:text-left">
          {/* Name / handle + secondary owner controls */}
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="font-wordmark text-display-sm text-moonbeem-ink m-0 break-words">
                {displayName}
              </h1>
              <p className="m-0 mt-1 text-body text-moonbeem-ink-subtle">
                @{profile.handle}
              </p>
            </div>
            {headerActions}
          </div>

          {/* Verified socials (elevated) → bio → watched → other links, on a
              uniform 16px cadence regardless of which are present. */}
          <div className="mt-5 space-y-4">
            {profile.verified_socials.length > 0 && (
              <ul className="flex flex-wrap justify-center gap-2 sm:justify-start">
                {profile.verified_socials.map((s) => (
                  <li key={s.platform}>
                    <a
                      href={buildSocialProfileUrl(s.platform, s.handle)}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="group inline-flex items-center gap-2 rounded-full border border-moonbeem-pink/30 bg-moonbeem-pink/10 px-3 py-1.5 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                      title={`Verified on ${PLATFORM_LABEL[s.platform]}`}
                    >
                      <PlatformIcon
                        platform={s.platform}
                        className="h-4 w-4 text-moonbeem-pink"
                      />
                      <span>@{s.handle}</span>
                      <span aria-label="Verified" className="text-emerald-300">
                        ✓
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {profile.bio && (
              <p className="max-w-2xl text-body text-moonbeem-ink whitespace-pre-line line-clamp-3">
                {profile.bio}
              </p>
            )}
            {watchedCount > 0 && (
              <Link
                href={`/c/${profile.handle}/watched`}
                className="m-0 inline-block w-fit text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
              >
                {watchedCount.toLocaleString()}{" "}
                {watchedCount === 1 ? "film" : "films"} watched →
              </Link>
            )}
            {profile.links.length > 0 && (
              <ul className="flex flex-wrap justify-center gap-2 sm:justify-start">
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
        </div>
      </header>

      {hasAnyContent ? (
        <>
          {/* TOP 12 (CF-4) — the visual hero. Rendered only when the creator
              has picks; partial fills keep Top12Grid's dashed empty slots. */}
          {topTitles.length > 0 && (
            <section className="flex flex-col gap-5">
              <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
                Top 12
              </h2>
              <Top12Grid
                topTitles={topTitles}
                isOwner={false}
                viaCreatorId={profile.creator_id}
              />
            </section>
          )}

          {/* FAN EDITS (CF-4) — their Moonbeem-native work, moved UP to sit
              directly under the Top 12 (was previously the last section). */}
          {fanEdits.length > 0 && (
            <section className="flex flex-col gap-5">
              <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
                Fan edits
              </h2>
              {/* CF-4: preview the first FAN_EDITS_PREVIEW_COUNT, then reveal
                  the rest via a server-pure <details>/<summary> (no client
                  island — the shared server card ProfileFanEditCard is never
                  wrapped). eager stays first-4-only; revealed cards are lazy. */}
              <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4">
                {fanEdits.slice(0, FAN_EDITS_PREVIEW_COUNT).map((fe, i) => (
                  <ProfileFanEditCard key={fe.id} fanEdit={fe} eager={i < 4} />
                ))}
              </div>
              {fanEdits.length > FAN_EDITS_PREVIEW_COUNT && (
                <details className="group">
                  <summary className="inline-flex w-fit cursor-pointer list-none text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink">
                    <span className="group-open:hidden">
                      View all {fanEdits.length} edits →
                    </span>
                    <span className="hidden group-open:inline">
                      Show fewer ↑
                    </span>
                  </summary>
                  <div className="mt-4 grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4">
                    {fanEdits.slice(FAN_EDITS_PREVIEW_COUNT).map((fe) => (
                      <ProfileFanEditCard key={fe.id} fanEdit={fe} eager={false} />
                    ))}
                  </div>
                </details>
              )}
            </section>
          )}

          {/* TASTE CLUSTER (CF-4) — diary + lists, a quieter grouped band
              below the work (side-by-side on lg). Subtle (ink-subtle)
              sub-headers so they read as depth, not headline. DiaryRow and
              ListCard usage is unchanged — only the grouping/layout differs. */}
          {(diary.length > 0 || lists.length > 0) && (
            <section className="grid gap-8 lg:grid-cols-2">
              {diary.length > 0 && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-ink-subtle uppercase m-0">
                    Diary
                  </h3>
                  <div className="flex flex-col gap-3">
                    {diary.map((e) => (
                      <DiaryRow key={e.id} entry={e} />
                    ))}
                  </div>
                </div>
              )}
              {lists.length > 0 && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-ink-subtle uppercase m-0">
                    Lists
                  </h3>
                  <div className="flex flex-col gap-3">
                    {lists.map((l) => (
                      <ListCard key={l.id} handle={handle} list={l} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        /* COLD/NEW PROFILE (CF-4) — dignified + minimal: a single understated
           line instead of bare dashed chrome. No owner-coaching CTAs on the
           public view (the header's owner controls suffice; coaching is /me). */
        <div className="border-t border-white/10 pt-8">
          <p className="m-0 text-body text-moonbeem-ink-subtle">
            This profile is just getting started.
          </p>
        </div>
      )}
    </div>
  );
}

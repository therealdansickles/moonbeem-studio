import Image from "next/image";
import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  getTopTitlesForUser,
  getUnclaimedStubEditsForUser,
} from "@/lib/queries/profiles";
import {
  getFanEditsForCreator,
  getPendingFanEditsForUser,
  getRejectedFanEditsForUser,
} from "@/lib/queries/titles";
import { getWatchedCountForCreator } from "@/lib/queries/watched";
import { SignOutButton } from "@/components/SignOutButton";
import PlatformIcon from "@/components/PlatformIcon";
import { isR2ThumbnailUrl } from "@/lib/fan-edits/thumbnail-url";
import ClaimStubButton from "@/components/me/ClaimStubButton";
import PayoutsControls from "@/components/me/PayoutsControls";
import { getAffiliateBalance } from "@/lib/affiliate/balance";
import WelcomeBanner from "@/components/me/WelcomeBanner";
import ProfileFanEditCard from "@/components/profile/ProfileFanEditCard";
import AvatarCircle from "@/components/profile/AvatarCircle";
import Top12Grid from "@/components/profile/Top12Grid";

const MIN_WITHDRAWAL_CENTS = 1000;

// Mirrors /c (ProfileView): show this many fan-edit cards before the
// "View all" expansion. The array is already ≤24 from getFanEditsForCreator;
// this is a display-layer preview cap on top of that.
const FAN_EDITS_PREVIEW_COUNT = 6;

// Primary pink-fill CTA — matches the welcome banner's "Pick films →"
// button exactly so the page's calls-to-action read as one system.
// self-start keeps it natural-width inside the flex-col section body.
const PINK_FILL_BTN =
  "inline-block self-start rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90";

// Secondary violet-fill CTA — same shape as the pink button but the
// brand's purple accent (moonbeem-violet). No self-start: the
// "Browse Moonbeem" block centers it via the parent's items-center.
const PURPLE_FILL_BTN =
  "inline-block rounded-md bg-moonbeem-violet px-4 py-2 text-body-sm font-semibold text-moonbeem-ink transition-opacity hover:opacity-90";

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

  // user profile (handle, display_name, bio, avatar, banner state)
  const { data: userRow } = await service
    .from("users")
    .select(
      "handle, display_name, bio, avatar_url, onboarding_banner_dismissed_at",
    )
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

  // earnings (creator-scoped). Aggregate total + this-month +
  // per-title in JS — small dataset, simpler than three queries.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString().slice(0, 10);
  const { data: earningsRows } = creator
    ? await service
      .from("creator_earnings")
      .select(
        "earnings_cents, calculation_date, title_id, titles(title)",
      )
      .eq("creator_id", creator.id)
    : { data: [] };
  let totalCents = 0;
  let monthCents = 0;
  const byTitle = new Map<string, { name: string; cents: number }>();
  for (const r of earningsRows ?? []) {
    const cents = (r.earnings_cents as number | null) ?? 0;
    totalCents += cents;
    if ((r.calculation_date as string) >= monthStartIso) monthCents += cents;
    const titleName = (r.titles as { title?: string } | null)?.title ?? "—";
    const tid = r.title_id as string;
    const existing = byTitle.get(tid) ?? { name: titleName, cents: 0 };
    existing.cents += cents;
    byTitle.set(tid, existing);
  }
  const titleBreakdown = [...byTitle.values()].sort(
    (a, b) => b.cents - a.cents,
  );

  // Payout state (creator_payout_accounts + unwithdrawn earnings sum
  // - pending withdrawals sum). Mirrors /api/me/payouts/status.
  //
  // The pending-withdrawal queries are SOURCE-SCOPED (the display mirror of the
  // producers' source-scoped re-entry guards, Stage 2a/2b): a pending CAMPAIGN
  // withdrawal must not mis-show on the affiliate control, and vice-versa. Both
  // include 'needs_reconciliation' (a parked transfer that already moved money)
  // to match each producer's blocking guard exactly — so the "in flight"
  // affordance and the server's accept/reject decision never disagree.
  const [payoutAcctRes, unwithdrawnRes, pendingRes, affiliatePendingRes] = creator
    ? await Promise.all([
      service
        .from("creator_payout_accounts")
        .select("onboarding_completed, payouts_enabled")
        .eq("creator_id", creator.id)
        .maybeSingle(),
      service
        .from("creator_earnings")
        .select("earnings_cents")
        .eq("creator_id", creator.id)
        .is("withdrawn_at", null),
      service
        .from("withdrawals")
        .select("amount_cents")
        .eq("creator_id", creator.id)
        .eq("source", "campaign")
        .in("status", ["pending", "needs_reconciliation"]),
      service
        .from("withdrawals")
        .select("amount_cents")
        .eq("creator_id", creator.id)
        .eq("source", "affiliate")
        .in("status", ["pending", "needs_reconciliation"]),
    ])
    : [{ data: null }, { data: [] }, { data: [] }, { data: [] }];
  const payoutAcct = (payoutAcctRes as { data: { onboarding_completed: boolean; payouts_enabled: boolean } | null }).data;
  const unwithdrawnCents = ((unwithdrawnRes.data ?? []) as Array<{ earnings_cents: number | null }>)
    .reduce((s, r) => s + (r.earnings_cents ?? 0), 0);
  const pendingWithdrawalCents = ((pendingRes.data ?? []) as Array<{ amount_cents: number | null }>)
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const availableCents = Math.max(0, unwithdrawnCents - pendingWithdrawalCents);
  // Pending AFFILIATE withdrawal (separate rail, separate Stripe transfer) —
  // drives the affiliate control's "in flight" affordance.
  const affiliatePendingCents = ((affiliatePendingRes.data ?? []) as Array<{ amount_cents: number | null }>)
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);

  // Affiliate earnings balance (Stage B) — held / 14d-matured cuts the creator
  // drove, from the settlement ledger via the SAME shared aggregate the
  // /api/me/affiliate/balance route uses (the single home of the validity
  // predicate, so the route and this page can never drift).
  const affiliateBalance = creator
    ? await getAffiliateBalance(creator.id)
    : { pending_cents: 0, available_cents: 0, lifetime_cents: 0 };

  // claimed status: if user has no handle, prompt to claim
  const handle = (userRow?.handle as string | null) ?? null;
  if (!handle) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
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

  // Top 12 picks — drives the "Your top 12" section's graduated
  // empty / partial / full state, and (with verified socials) the
  // welcome-banner trigger.
  const topTitles = await getTopTitlesForUser(session.userId);
  const top12Count = topTitles.length;

  // Fan edits attributed to this user's creator — empty array when
  // no creator row exists or when none are attributed yet. Renders
  // a grid when populated, falls back to the editorial empty state
  // below.
  const fanEdits = creator
    ? await getFanEditsForCreator(creator.id)
    : [];

  // Diary entry count — drives the "Your diary" section.
  const diaryCount = creator
    ? (
        await service
          .from("diary_entries")
          .select("id", { count: "exact", head: true })
          .eq("creator_id", creator.id)
      ).count ?? 0
    : 0;

  // List count — drives the "Your lists" section.
  const listsCount = creator
    ? (
        await service
          .from("user_lists")
          .select("id", { count: "exact", head: true })
          .eq("creator_id", creator.id)
      ).count ?? 0
    : 0;

  // Watched count (public) — drives the "Your watched" section. It links to the
  // public grid (watched has no /me management page; marks happen on title
  // pages), so the count mirrors what that grid actually shows.
  const watchedCount = creator
    ? await getWatchedCountForCreator(creator.id)
    : 0;

  // Stub creators with edits that look like they belong to this user
  // (handle match or already-verified-social match). Surfaces an
  // "Edits to claim" prompt; only renders when non-empty.
  const unclaimedStubs = await getUnclaimedStubEditsForUser(session.userId);

  // Block 3: user-submitted edits awaiting / rejected by admin review.
  const [pendingSubmissions, rejectedSubmissions] = await Promise.all([
    getPendingFanEditsForUser(session.userId),
    getRejectedFanEditsForUser(session.userId),
  ]);

  // Welcome banner shows only for a genuine first-time user: no
  // verified socials, no Top 12 picks, and no prior dismissal.
  const bannerDismissedAt =
    (userRow?.onboarding_banner_dismissed_at as string | null) ?? null;
  const showWelcomeBanner =
    bannerDismissedAt === null &&
    verifiedSocials.length === 0 &&
    top12Count === 0;

  // "Browse Moonbeem" standalone block — the next nudge for a user
  // who has started a Top 12 but hasn't verified a handle yet.
  // Inverse-ish of the welcome banner: it appears once top12Count
  // crosses 0, and disappears the moment any handle is verified.
  // (v1 has no explicit dismiss — the conditions handle visibility.)
  const showBrowseMoonbeem =
    top12Count >= 1 && verifiedSocials.length === 0;

  return (
    <div className="min-h-screen px-6 py-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-14">
        {/* ───────── IDENTITY TIER (wide) ───────── */}
        <div className="flex flex-col gap-6">
          {/* Header — /c editorial treatment (ProfileView), owner variant:
              AvatarCircle left, identity stack right on sm+; verified pills
              elevated under the name; owner controls grouped secondary. */}
          <header className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <AvatarCircle
              avatarUrl={avatarUrl}
              displayName={displayName}
              handle={handle}
              size={112}
              className="shrink-0"
            />
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h1 className="font-wordmark text-display-sm text-moonbeem-ink m-0 break-words">
                    {displayName ?? handle}
                  </h1>
                  <p className="m-0 mt-1 text-body text-moonbeem-ink-subtle">
                    @{handle}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <Link
                    href="/me/edit"
                    className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                  >
                    Edit profile
                  </Link>
                  <Link
                    href={`/c/${handle}`}
                    className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-body-sm text-moonbeem-ink-muted transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                  >
                    View public profile
                  </Link>
                </div>
              </div>
              {/* Verified pills DISPLAY elevated (pulled up from the old
                  Verified-accounts section; the management block stays in the
                  account tier below). bio under the pills. */}
              <div className="mt-5 space-y-4">
                {verifiedSocials.length > 0 && (
                  <ul className="flex flex-wrap justify-center gap-2 sm:justify-start">
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
                        <span className="sr-only">
                          verified on {platformLabel[s.platform]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {bio && (
                  <p className="max-w-2xl text-body text-moonbeem-ink whitespace-pre-line">
                    {bio}
                  </p>
                )}
              </div>
            </div>
          </header>

          {showWelcomeBanner && <WelcomeBanner handle={handle} />}
        </div>

        {/* ───────── HERO TIER (wide) — Top 12, owner-editable ───────── */}
        <section className="flex flex-col gap-5">
          <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
            Your top 12
          </h2>
          {/* CF-4 way: the wide grid comes purely from the max-w-7xl
              container — no breakout wrapper, no relative/translateX. isOwner
              enables the inline Add film / Reorder / per-slot remove controls;
              slot count stays 12. */}
          <Top12Grid topTitles={topTitles} isOwner={true} />
        </section>

        {/* ───────── YOUR-WORK TIER — submissions lifecycle ───────── */}
        <div className="flex flex-col gap-8">
          {/* Fan edits (live) — same ProfileFanEditCard, with the /c
              6-preview cap + view-all <details>/<summary>. */}
          <section className="flex flex-col gap-5">
            <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-pink uppercase m-0">
              Your fan edits{fanEdits.length > 0 ? ` (${fanEdits.length})` : ""}
            </h2>
            {fanEdits.length > 0 ? (
              <>
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
                <Link
                  href="/"
                  className="inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                >
                  Browse fan edits other creators have made →
                </Link>
              </>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  Fan edits you&apos;ve made on social platforms will appear here
                  once they&apos;re attributed to your verified accounts. Each edit
                  shows view counts, partner attribution, and earnings.
                </p>
                <Link
                  href={`/c/${handle}/upload`}
                  className="rounded-md border border-white/15 bg-white/5 px-4 py-2 text-body-sm text-moonbeem-ink transition-colors hover:border-moonbeem-pink hover:text-moonbeem-pink"
                >
                  Add fan edit
                </Link>
                <Link
                  href="/"
                  className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
                >
                  Browse fan edits other creators have made →
                </Link>
              </div>
            )}
          </section>

          {/* Under review — pending submissions (conditional). */}
          {pendingSubmissions.length > 0 && (
            <section>
              <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Under review ({pendingSubmissions.length})
              </h2>
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="text-body-sm text-moonbeem-ink-muted m-0">
                  {pendingSubmissions.length === 1
                    ? "1 fan edit"
                    : `${pendingSubmissions.length} fan edits`}{" "}
                  under review. We aim to respond within 24 hours.
                </p>
                <ul className="mt-3 flex flex-col gap-2">
                  {pendingSubmissions.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] p-2"
                    >
                      {isR2ThumbnailUrl(s.thumbnail_url) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.thumbnail_url}
                          alt=""
                          width={48}
                          height={48}
                          className="h-12 w-12 rounded-md object-cover bg-black/40"
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-md bg-black/40" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-body-sm text-moonbeem-ink truncate">
                          {s.title_name}
                        </p>
                        <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
                          {platformLabel[s.platform as SocialPlatform]}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* Edits to claim — conditional (ClaimStubButton). */}
          {unclaimedStubs.length > 0 && (
            <section>
              <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Edits to claim
              </h2>
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  We&apos;ve found edits attributed to social handles that
                  look like yours. Verify the handle to claim them.
                </p>
                <ul className="mt-4 flex flex-col gap-3">
                  {unclaimedStubs.map((stub) => {
                    // CTA selection. The verify-then-merge flow at
                    // /me/edit only works when (a) the surface tied the
                    // stub to a handle the user could still verify on
                    // a not-yet-verified platform AND (b) the
                    // verification's exact (platform, lower(handle))
                    // lookup will hit the stub's social row. Heuristic
                    // (a) — user_handle — only satisfies that when the
                    // user hasn't verified the same platform under any
                    // other handle (otherwise VerifySocialsCard
                    // silently skips and dead-ends). Heuristic (b) —
                    // verified_social — implies the user already
                    // verified the platform, so verify-to-claim always
                    // dead-ends there. The Claim button calls the new
                    // merge_stub_creator RPC directly and works for
                    // both heuristics.
                    const platformAlreadyVerified = verifiedSocials.some(
                      (v) => v.platform === stub.platform,
                    );
                    const useVerifyLink =
                      stub.matchType === "user_handle" &&
                      !platformAlreadyVerified;
                    return (
                      <li
                        key={stub.stubCreatorId}
                        className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.02] p-3"
                      >
                        {stub.thumbnails.length > 0 ? (
                          <div className="flex shrink-0 -space-x-2">
                            {stub.thumbnails.slice(0, 3).map((src, i) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={src}
                                src={src}
                                alt=""
                                width={40}
                                height={40}
                                className="h-10 w-10 rounded-md border border-white/15 bg-black/40 object-cover"
                                style={{ zIndex: 3 - i }}
                              />
                            ))}
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="m-0 text-body-sm text-moonbeem-ink">
                            {stub.fanEditCount} edit
                            {stub.fanEditCount === 1 ? "" : "s"} as @
                            {stub.socialHandle} on{" "}
                            {platformLabel[stub.platform as SocialPlatform]}
                          </p>
                        </div>
                        {useVerifyLink ? (
                          <Link
                            href={`/me/edit?return_to=${encodeURIComponent("/me")}&platform=${stub.platform}&handle=${encodeURIComponent(stub.socialHandle)}`}
                            className="shrink-0 text-body-sm text-moonbeem-pink hover:opacity-90"
                          >
                            Verify to claim →
                          </Link>
                        ) : (
                          <ClaimStubButton stubCreatorId={stub.stubCreatorId} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          )}

          {/* Rejected submissions — conditional collapsible, quiet. */}
          {rejectedSubmissions.length > 0 && (
            <section>
              <details className="group">
                <summary className="cursor-pointer text-body font-medium text-moonbeem-ink-muted hover:text-moonbeem-ink list-none">
                  Rejected submissions ({rejectedSubmissions.length})
                  <span className="ml-2 text-moonbeem-ink-subtle group-open:hidden">
                    ↓
                  </span>
                  <span className="ml-2 text-moonbeem-ink-subtle hidden group-open:inline">
                    ↑
                  </span>
                </summary>
                <div className="mt-3 border-t border-white/10 pt-3">
                  <ul className="flex flex-col gap-3">
                    {rejectedSubmissions.map((s) => (
                      <li
                        key={s.id}
                        className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-3"
                      >
                        <div className="flex items-start gap-3">
                          {isR2ThumbnailUrl(s.thumbnail_url) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={s.thumbnail_url}
                              alt=""
                              width={56}
                              height={56}
                              className="h-14 w-14 rounded-md object-cover bg-black/40 shrink-0"
                            />
                          ) : (
                            <div className="h-14 w-14 rounded-md bg-black/40 shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="m-0 text-body-sm text-moonbeem-ink">
                              {s.title_name}
                            </p>
                            <p className="m-0 text-body-sm text-moonbeem-ink-subtle">
                              {platformLabel[s.platform as SocialPlatform]}
                            </p>
                            {s.rejection_reason && (
                              <p className="mt-1 text-body-sm text-moonbeem-ink-muted">
                                {s.rejection_reason}
                              </p>
                            )}
                          </div>
                        </div>
                        <a
                          href={`mailto:hello@moonbeem.studio?subject=${encodeURIComponent(`Appeal: ${s.post_id ?? s.id}`)}`}
                          className="self-start text-body-sm text-moonbeem-pink hover:opacity-90"
                        >
                          Appeal via email →
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </section>
          )}
        </div>

        {/* ───────── LIBRARY TIER (wide, grouped cluster) ───────── */}
        <section className="flex flex-col gap-5">
          <h2 className="font-wordmark text-caption tracking-[0.2em] text-moonbeem-ink-subtle uppercase m-0">
            Library
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Your diary — count + link. */}
            <section>
              <h3 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Your diary{diaryCount > 0 ? ` (${diaryCount})` : ""}
              </h3>
              <div className="mt-3 border-t border-white/10 pt-3">
                {diaryCount === 0 ? (
                  <>
                    <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                      Log films and series you&apos;ve watched — with a rating, a
                      date, and an optional review. They show on your profile.
                    </p>
                    <Link
                      href="/me/diary"
                      className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                    >
                      Go to your diary →
                    </Link>
                  </>
                ) : (
                  <Link
                    href="/me/diary"
                    className="inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                  >
                    View your diary →
                  </Link>
                )}
              </div>
            </section>

            {/* Your watched — public count + link. */}
            <section>
              <h3 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Your watched{watchedCount > 0 ? ` (${watchedCount})` : ""}
              </h3>
              <div className="mt-3 border-t border-white/10 pt-3">
                {watchedCount === 0 ? (
                  <>
                    <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                      Mark films watched from their pages. They show on your profile.
                    </p>
                    <Link
                      href={`/c/${handle}/watched`}
                      className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                    >
                      View your watched →
                    </Link>
                  </>
                ) : (
                  <Link
                    href={`/c/${handle}/watched`}
                    className="inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                  >
                    View your watched →
                  </Link>
                )}
              </div>
            </section>

            {/* Your lists — count + link. */}
            <section>
              <h3 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Your lists{listsCount > 0 ? ` (${listsCount})` : ""}
              </h3>
              <div className="mt-3 border-t border-white/10 pt-3">
                {listsCount === 0 ? (
                  <>
                    <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                      Group films into lists, or keep a watchlist. They show on your
                      profile.
                    </p>
                    <Link
                      href="/me/lists"
                      className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                    >
                      Go to your lists →
                    </Link>
                  </>
                ) : (
                  <Link
                    href="/me/lists"
                    className="inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                  >
                    View your lists →
                  </Link>
                )}
              </div>
            </section>

            {/* Import from Letterboxd. */}
            <section>
              <h3 className="text-body font-medium text-moonbeem-ink-muted m-0">
                Import from Letterboxd
              </h3>
              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  Bring over your ratings, diary, reviews, watchlist, and lists from
                  a Letterboxd export. We&apos;ll match your films to Moonbeem and
                  show you a preview first.
                </p>
                <Link
                  href="/me/letterboxd"
                  className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                >
                  Import your data →
                </Link>
              </div>
            </section>
          </div>

          {/* Browse Moonbeem — empty-state nudge for the started-but-unverified
              user; lives in the library tier. */}
          {showBrowseMoonbeem && (
            <div className="flex flex-col items-center gap-2 py-2">
              <p className="m-0 text-caption text-moonbeem-ink-subtle">
                Keep exploring
              </p>
              <Link href="/" className={PURPLE_FILL_BTN}>
                Browse Moonbeem
              </Link>
            </div>
          )}
        </section>

        {/* ───────── ACCOUNT TIER (readable measure, quieter) ───────── */}
        <div className="flex w-full max-w-2xl flex-col gap-10">

        {/* 3. Verified accounts */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Verified accounts
          </h2>
          <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3">
            {verifiedSocials.length === 0
              ? (
                <>
                  <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                    Verify your account to upload your fan edits from TikTok,
                    Instagram, X, and YouTube. Your edits will be attributed to
                    the titles you love, and you&apos;ll earn from views and
                    transactions.
                  </p>
                  {/* Once the user has started a Top 12, verification is
                      their clear next step — promote the CTA to a pink
                      fill button. Otherwise it stays a quiet text link. */}
                  {top12Count >= 1
                    ? (
                      <Link href="/me/edit" className={PINK_FILL_BTN}>
                        Verify a handle →
                      </Link>
                    )
                    : (
                      <Link
                        href="/me/edit"
                        className="self-start text-body-sm text-moonbeem-pink hover:opacity-90"
                      >
                        Verify a handle →
                      </Link>
                    )}
                </>
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
                      <span className="sr-only">
                        verified on {platformLabel[s.platform]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </section>

        {/* 4. Earnings — read-only summary. Empty state has no CTA
            (a proper earnings explainer is banked for v2). */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Earnings
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            {verifiedSocials.length === 0 && totalCents === 0
              ? (
                pendingSubmissions.length > 0 ? (
                  // Pending-edit progress copy. Active when a creator
                  // has zero earnings but at least one submission
                  // awaiting admin review — replaces the passive
                  // "When you create authorized fan edits…" empty-
                  // state so the section acknowledges the work in
                  // flight. The 24h response window is already shown
                  // in the "Under review" section above, so this copy
                  // stays earnings-focused and avoids duplicating it.
                  <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                    {pendingSubmissions.length === 1
                      ? "Your edit is under review. Earnings start the moment it's approved."
                      : "Your edits are under review. Earnings start the moment they're approved."}
                  </p>
                ) : (
                  <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                    When you create authorized fan edits, partners pay you for
                    views and clicks through to their content. Earnings appear
                    here once you&apos;ve verified a social handle and started
                    getting attribution.
                  </p>
                )
              )
              : (
                <div className="flex flex-col gap-4">
                  {totalCents === 0 && pendingSubmissions.length > 0 && (
                    // Same pending-edit progress copy as the empty-
                    // state branch, surfaced ABOVE the $0.00 numbers
                    // when a verified-social creator is waiting for
                    // their first edit to be approved. Without this,
                    // the populated dashboard shows just $0.00 with
                    // no acknowledgment of the submission in flight.
                    <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                      {pendingSubmissions.length === 1
                        ? "Your edit is under review. Earnings start the moment it's approved."
                        : "Your edits are under review. Earnings start the moment they're approved."}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="font-wordmark text-display-sm text-moonbeem-pink leading-none">
                        ${(totalCents / 100).toFixed(2)}
                      </div>
                      <div className="mt-1 text-caption text-moonbeem-ink-subtle">
                        total to date
                      </div>
                    </div>
                    <div>
                      <div className="font-wordmark text-display-sm text-moonbeem-ink leading-none">
                        ${(monthCents / 100).toFixed(2)}
                      </div>
                      <div className="mt-1 text-caption text-moonbeem-ink-subtle">
                        this month
                      </div>
                    </div>
                  </div>
                  {titleBreakdown.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {titleBreakdown.map((t) => (
                        <li
                          key={t.name}
                          className="flex items-center justify-between text-body-sm"
                        >
                          <span className="text-moonbeem-ink-muted">
                            {t.name}
                          </span>
                          <span className="tabular-nums text-moonbeem-ink">
                            ${(t.cents / 100).toFixed(2)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-body-sm text-moonbeem-ink-muted">
                        Available to withdraw
                      </span>
                      <span className="text-body font-semibold tabular-nums text-moonbeem-pink">
                        ${(availableCents / 100).toFixed(2)}
                      </span>
                    </div>
                    {pendingWithdrawalCents > 0 && (
                      <div className="flex items-baseline justify-between">
                        <span className="text-caption text-moonbeem-ink-subtle">
                          Pending transfer
                        </span>
                        <span className="text-caption tabular-nums text-moonbeem-ink-muted">
                          ${(pendingWithdrawalCents / 100).toFixed(2)}
                        </span>
                      </div>
                    )}
                    <div className="mt-2">
                      <PayoutsControls
                        hasAccount={!!payoutAcct}
                        onboardingCompleted={!!payoutAcct?.onboarding_completed}
                        payoutsEnabled={!!payoutAcct?.payouts_enabled}
                        availableCents={availableCents}
                        pendingCents={pendingWithdrawalCents}
                        minimumCents={MIN_WITHDRAWAL_CENTS}
                      />
                    </div>
                  </div>
                </div>
              )}

            {/* Affiliate earnings (Stage B) — held/maturity cuts the creator
                drove via their Top-12. Rendered as a SIBLING of the campaign-
                earnings branches above, on its OWN criterion (lifetime_cents > 0)
                — so a curator with affiliate earnings but NO campaign earnings
                (the typical case) still sees it AND can cash out. The withdraw
                control (Stage 4) reuses PayoutsControls via withdrawPath, posting
                to the affiliate producer; the shared Connect account means its
                onboarding affordances (set up / complete / verifying) are correct
                for both rails, while available + pending are affiliate-scoped. */}
            {affiliateBalance.lifetime_cents > 0 && (
              <div className="mt-3 flex flex-col gap-1 border-t border-white/10 pt-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-body-sm text-moonbeem-ink-muted">
                    Affiliate earnings
                  </span>
                  <span className="text-caption text-moonbeem-ink-subtle">
                    From rentals you drove
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-caption text-moonbeem-ink-subtle tabular-nums">
                    ${(affiliateBalance.pending_cents / 100).toFixed(2)} pending
                  </span>
                  <span className="text-body font-semibold tabular-nums text-moonbeem-pink">
                    ${(affiliateBalance.available_cents / 100).toFixed(2)} available
                  </span>
                </div>
                <div className="mt-2">
                  <PayoutsControls
                    withdrawPath="/api/me/affiliate/withdraw"
                    hasAccount={!!payoutAcct}
                    onboardingCompleted={!!payoutAcct?.onboarding_completed}
                    payoutsEnabled={!!payoutAcct?.payouts_enabled}
                    availableCents={affiliateBalance.available_cents}
                    pendingCents={affiliatePendingCents}
                    minimumCents={MIN_WITHDRAWAL_CENTS}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 5. Recent activity — informational empty state, no CTA. */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Recent activity
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
              Plays, edits, and other activity from people watching and
              engaging with your work will show up here.
            </p>
            <p className="mt-2 text-body-sm text-moonbeem-ink-subtle m-0">
              Once you&apos;ve published edits or built your top 12,
              you&apos;ll start seeing activity.
            </p>
          </div>
        </section>
        </div>

        {/* Footer — contact + sign out, outside the account tier. */}
        <div className="mt-2 flex flex-col items-center gap-4">
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            Questions? Get in touch at{" "}
            <a
              href="mailto:hello@moonbeem.xyz"
              className="text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              hello@moonbeem.xyz
            </a>
            .
          </p>
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}

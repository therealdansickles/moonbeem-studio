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
import { SignOutButton } from "@/components/SignOutButton";
import PlatformIcon from "@/components/PlatformIcon";
import PayoutsControls from "@/components/me/PayoutsControls";
import WelcomeBanner from "@/components/me/WelcomeBanner";
import ProfileFanEditCard from "@/components/profile/ProfileFanEditCard";

const MIN_WITHDRAWAL_CENTS = 1000;

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
  const [payoutAcctRes, unwithdrawnRes, pendingRes] = creator
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
        .eq("status", "pending"),
    ])
    : [{ data: null }, { data: [] }, { data: [] }];
  const payoutAcct = (payoutAcctRes as { data: { onboarding_completed: boolean; payouts_enabled: boolean } | null }).data;
  const unwithdrawnCents = ((unwithdrawnRes.data ?? []) as Array<{ earnings_cents: number | null }>)
    .reduce((s, r) => s + (r.earnings_cents ?? 0), 0);
  const pendingWithdrawalCents = ((pendingRes.data ?? []) as Array<{ amount_cents: number | null }>)
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const availableCents = Math.max(0, unwithdrawnCents - pendingWithdrawalCents);

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

        {showWelcomeBanner && <WelcomeBanner handle={handle} />}

        {/* Block 3: pending submissions — only renders when the user
            has submitted at least one URL still awaiting admin review.
            No interactive controls (admin handles via queue). */}
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
                    {s.thumbnail_url ? (
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

        {/* 1. Your fan edits — grid when this user's creator has any
            attributed edits; editorial empty state otherwise. */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Your fan edits
            {fanEdits.length > 0 ? ` (${fanEdits.length})` : ""}
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            {fanEdits.length > 0 ? (
              <>
                <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4">
                  {fanEdits.map((fe, i) => (
                    <ProfileFanEditCard
                      key={fe.id}
                      fanEdit={fe}
                      eager={i < 4}
                    />
                  ))}
                </div>
                <Link
                  href="/"
                  className="mt-4 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                >
                  Browse fan edits other creators have made →
                </Link>
              </>
            ) : (
              <>
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  Fan edits you&apos;ve made on social platforms will appear here
                  once they&apos;re attributed to your verified accounts. Each edit
                  shows view counts, partner attribution, and earnings.
                </p>
                <div className="mt-3 flex flex-col items-start gap-3">
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
              </>
            )}
          </div>
        </section>

        {/* Block 3: rejected submissions — collapsible. Default
            collapsed so the rejection state doesn't dominate /me for
            users with one-off rejections. Uses <details> for native
            zero-JS toggle. */}
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
                        {s.thumbnail_url ? (
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

        {/* 1.5. Edits to claim — only renders when stubs plausibly
            belong to this user are surfaced by
            getUnclaimedStubEditsForUser. */}
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
                {unclaimedStubs.map((stub) => (
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
                    <Link
                      href={`/me/edit?return_to=${encodeURIComponent("/me")}&platform=${stub.platform}&handle=${encodeURIComponent(stub.socialHandle)}`}
                      className="shrink-0 text-body-sm text-moonbeem-pink hover:opacity-90"
                    >
                      Verify to claim →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {/* 2. Your top 12 — graduated state: 0 picks, 1-11, or 12. */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Your top 12
            {top12Count > 0 && top12Count < 12 ? ` (${top12Count} picked)` : ""}
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            {top12Count === 0 ? (
              <>
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  Pick films and series that mean something to you.
                  They&apos;ll show on your profile so others can see your
                  taste.
                </p>
                <p className="mt-2 text-body-sm text-moonbeem-ink-subtle m-0">
                  3 minimum, 12 maximum.
                </p>
                <Link
                  href="/me/top-12"
                  className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                >
                  Pick films →
                </Link>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {topTitles.map((t) => (
                    <div
                      key={t.id}
                      className="relative aspect-[2/3] w-[60px] shrink-0 overflow-hidden rounded-md bg-moonbeem-navy/40"
                    >
                      {t.title.poster_url ? (
                        <Image
                          src={t.title.poster_url}
                          alt={t.title.title}
                          fill
                          sizes="60px"
                          unoptimized
                          className="object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center p-1 text-center text-caption text-moonbeem-ink-subtle">
                          {t.title.title}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <Link
                  href="/me/top-12"
                  className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
                >
                  {top12Count === 12 ? "Edit your list →" : "Add more films →"}
                </Link>
              </>
            )}
          </div>
        </section>

        {/* Browse Moonbeem — standalone nudge between Top 12 and
            Verified accounts. Shown only once the user has started a
            Top 12 and still has no verified handle. */}
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
                <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
                  When you create authorized fan edits, partners pay you for
                  views and clicks through to their content. Earnings appear
                  here once you&apos;ve verified a social handle and started
                  getting attribution.
                </p>
              )
              : (
                <div className="flex flex-col gap-4">
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

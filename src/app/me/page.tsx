import Image from "next/image";
import Link from "next/link";
import { verifySession } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getTopTitlesForUser } from "@/lib/queries/profiles";
import { SignOutButton } from "@/components/SignOutButton";
import PlatformIcon from "@/components/PlatformIcon";
import PayoutsControls from "@/components/me/PayoutsControls";
import WelcomeBanner from "@/components/me/WelcomeBanner";

const MIN_WITHDRAWAL_CENTS = 1000;

// Primary pink-fill CTA — matches the welcome banner's "Pick films →"
// button exactly so the page's calls-to-action read as one system.
// self-start keeps it natural-width inside the flex-col section body.
const PINK_FILL_BTN =
  "inline-block self-start rounded-md bg-moonbeem-pink px-4 py-2 text-body-sm font-semibold text-moonbeem-navy transition-opacity hover:opacity-90";

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

  // Welcome banner shows only for a genuine first-time user: no
  // verified socials, no Top 12 picks, and no prior dismissal.
  const bannerDismissedAt =
    (userRow?.onboarding_banner_dismissed_at as string | null) ?? null;
  const showWelcomeBanner =
    bannerDismissedAt === null &&
    verifiedSocials.length === 0 &&
    top12Count === 0;

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

        {/* 1. Your fan edits — no real data wired yet; always the
            editorial empty state for now. */}
        <section>
          <h2 className="text-body font-medium text-moonbeem-ink-muted m-0">
            Your fan edits
          </h2>
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="text-body-sm text-moonbeem-ink-muted leading-relaxed m-0">
              Fan edits you&apos;ve made on social platforms will appear here
              once they&apos;re attributed to your verified accounts. Each edit
              shows view counts, partner attribution, and earnings.
            </p>
            <Link
              href="/"
              className="mt-3 inline-block text-body-sm text-moonbeem-pink hover:opacity-90"
            >
              Browse fan edits other creators have made →
            </Link>
          </div>
        </section>

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
            {/* Always-on alternate path — "browse for a while first" is
                a legitimate option per the welcome banner's closing line. */}
            <Link href="/" className={PINK_FILL_BTN}>
              Browse Moonbeem
            </Link>
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

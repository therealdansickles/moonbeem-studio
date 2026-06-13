// Public campaign landing for a title: /t/[slug]/campaign.
//
// Shows the campaign's real earning mechanics (CPM, settle window) and a
// single next action keyed to the viewer's auth state. NEVER surfaces
// budget_pool_cents or remaining budget — CPM is the only money figure.
//
// Same loader + liveness gate as the title page (getTitleBySlug +
// canViewTitle → notFound). No active/ended campaign → redirect to the
// title page. Draft campaigns are invisible (the query won't return them).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTitleBySlug } from "@/lib/queries/titles";
import { getCampaignForTitlePage } from "@/lib/queries/campaign-page";
import { canViewTitle } from "@/lib/title-access";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/dal";
import { getUserTier } from "@/lib/gating/get-user-tier";
import SingleUrlSubmitForm from "@/components/fan-edits/SingleUrlSubmitForm";

export const metadata: Metadata = {
  title: "Campaign — Moonbeem",
};

type PageProps = { params: Promise<{ slug: string }> };

// Local helper, matching the campaign surfaces' convention (formatCents is
// not a shared export). CPM only — never used on a budget figure here.
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PRIMARY_LINK =
  "self-start rounded-md bg-moonbeem-pink text-moonbeem-navy px-4 py-2 text-body font-semibold hover:opacity-90 transition-opacity";

// Constant across every auth state and across active/ended.
const STEPS = [
  "Verify a social account. Takes about two minutes.",
  "Make your edit. Use the clips and stills from the title page.",
  "Post it on TikTok, Instagram, X, or YouTube.",
  "Submit your link below. We review every submission, usually within a day. Approved edits start counting views.",
];

export default async function TitleCampaignPage({ params }: PageProps) {
  const { slug } = await params;

  // SAME loader + liveness gate as the title page.
  const title = await getTitleBySlug(slug);
  if (!title) notFound();
  const visible = await canViewTitle({
    is_public: title.is_public,
    partner_id: title.partner_id,
  });
  if (!visible) notFound();

  const campaign = await getCampaignForTitlePage(title.id);
  if (!campaign) redirect(`/t/${title.slug}`);

  // Auth ladder — mirrors the title page. getUserTier collapses
  // creator/no-creator into "signed_in", so the claimed handle
  // (gateProfile.handle) is the signal that distinguishes them, exactly as
  // the title page's "Add yours" link does. Super-admins are coerced to
  // verified for parity with the title page.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const gateProfile = await getCurrentProfile();
  const isSuperAdmin = gateProfile?.role === "super_admin";
  const effectiveTier = isSuperAdmin
    ? "verified"
    : await getUserTier(user?.id ?? null);
  const hasCreator = !!gateProfile?.handle;

  const here = `/t/${title.slug}/campaign`;

  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        {/* Header: small poster + back link + campaign name + partner */}
        <div className="flex items-start gap-4">
          {title.poster_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={title.poster_url}
              alt={title.title}
              width={64}
              height={96}
              className="flex-none rounded-md object-cover bg-black/40"
            />
          ) : null}
          <div className="flex flex-col gap-1 min-w-0">
            <Link
              href={`/t/${title.slug}`}
              className="text-body-sm text-moonbeem-ink-muted hover:text-moonbeem-pink"
            >
              ← {title.title}
            </Link>
            <h1 className="font-wordmark font-bold text-display-sm md:text-display-md text-moonbeem-pink m-0">
              {campaign.name}
            </h1>
            <p className="text-body-sm text-moonbeem-ink-muted">
              A campaign from {campaign.partnerName}
            </p>
          </div>
        </div>

        {/* Earnings block — real mechanics. CPM is the only money figure. */}
        <div className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.02] p-4">
          <p className="text-body text-moonbeem-ink">
            Earn {formatCents(campaign.cpmRateCents)} per 1,000 views.
          </p>
          <p className="text-body-sm text-moonbeem-ink-muted">
            Views are measured from what each platform publicly reports. Each
            day&apos;s views settle for {campaign.settlingDays} days before
            they pay out.
          </p>
          <p className="text-body-sm text-moonbeem-ink-subtle">
            Paid from a fixed campaign budget. If the remaining budget cannot
            cover all qualified views in a payout cycle, payouts are split
            proportionally. Withdraw earnings from $10.
          </p>
        </div>

        {/* Brief block — only when present. Whitespace preserved. */}
        {campaign.brief ? (
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-moonbeem-ink-subtle uppercase tracking-wider">
              From {campaign.partnerName}
            </p>
            <p className="text-body text-moonbeem-ink whitespace-pre-line">
              {campaign.brief}
            </p>
          </div>
        ) : null}

        {/* Steps — constant across states. */}
        <ol className="flex flex-col gap-3 list-none p-0 m-0">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex-none flex h-6 w-6 items-center justify-center rounded-full bg-moonbeem-pink/15 text-body-sm font-semibold text-moonbeem-pink">
                {i + 1}
              </span>
              <span className="text-body text-moonbeem-ink">{step}</span>
            </li>
          ))}
        </ol>

        {/* Action area — exactly one next action per state. */}
        <div className="flex flex-col gap-3">
          {campaign.ended ? (
            <div className="flex flex-col gap-1">
              <p className="text-body text-moonbeem-ink">
                This campaign has ended.
              </p>
              <p className="text-body-sm text-moonbeem-ink-muted">
                You can still add fan edits from the title page.
              </p>
            </div>
          ) : !user ? (
            <Link
              href={`/login?redirect_to=${encodeURIComponent(here)}`}
              className={PRIMARY_LINK}
            >
              Sign in to submit your edit
            </Link>
          ) : !hasCreator ? (
            <Link
              href={`/onboarding/handle?next=${encodeURIComponent(here)}`}
              className={PRIMARY_LINK}
            >
              Claim your Moonbeem handle to get started
            </Link>
          ) : effectiveTier !== "verified" ? (
            <Link
              href={`/me/edit?return_to=${encodeURIComponent(here)}`}
              className={PRIMARY_LINK}
            >
              Verify a social account to submit. Takes about two minutes.
            </Link>
          ) : (
            <SingleUrlSubmitForm
              pinnedTitle={{ id: title.id, name: title.title }}
              successMessage="Submitted. We review every submission, usually within a day."
            />
          )}
        </div>
      </div>
    </div>
  );
}

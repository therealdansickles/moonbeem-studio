import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getActiveClipsForTitle,
  getActiveFanEditsForTitle,
  getActiveOffersForTitle,
  getActiveStillsForTitle,
  getTitleBySlug,
  getTitleEpisodes,
  isTitleInActiveCampaign,
  type TitleOffer,
} from "@/lib/queries/titles";
import TitleTabs from "@/components/TitleTabs";
import EpisodeList from "@/components/EpisodeList";
import FanEditsTab from "@/components/FanEditsTab";
import VideosTab from "@/components/VideosTab";
import StillsTab from "@/components/StillsTab";
import RequestFanEditsCTA from "@/components/RequestFanEditsCTA";
import RequestSubmittedToast from "@/components/RequestSubmittedToast";
import AboutCredits from "@/components/AboutCredits";
import OfferButtonClient from "@/components/OfferButtonClient";
import TitlePosterShared from "@/components/TitlePosterShared";
import { createClient } from "@/lib/supabase/server";
import { canViewTitle } from "@/lib/title-access";
import { getCurrentProfile } from "@/lib/dal";
import { getUserTier } from "@/lib/gating/get-user-tier";
import { getUsageCount } from "@/lib/gating/usage-counts";
import { Suspense } from "react";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const title = await getTitleBySlug(slug);
  if (!title) return { title: "Not found" };
  // Don't leak the title name + poster via OpenGraph for unlisted
  // titles. Pre-launch URLs shared accidentally still 404 for non-
  // members, and the metadata stays neutral.
  const visible = await canViewTitle({
    is_public: title.is_public,
    partner_id: title.partner_id,
  });
  if (!visible) return { title: "Not found" };
  const description =
    title.synopsis?.slice(0, 160) ?? `Watch ${title.title} on Moonbeem.`;
  return {
    title: `${title.title} on Moonbeem`,
    description,
    openGraph: {
      title: title.title,
      description,
      // images intentionally omitted — opengraph-image.tsx in this
      // segment auto-generates a branded 1200x630 card (poster +
      // title meta) that supersedes any here.
    },
    twitter: {
      card: "summary_large_image",
      title: title.title,
      description,
    },
  };
}

function OfferButton({
  offer,
  titleId,
}: {
  offer: TitleOffer;
  titleId: string;
}) {
  if (!offer.provider_url) return null;
  const label = offer.provider ?? "Watch";
  const isPrimary = offer.offer_type === "theatrical";
  const className = isPrimary
    ? "bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-3 text-body font-semibold hover:opacity-90 transition-opacity text-center"
    : "bg-transparent border border-moonbeem-pink text-moonbeem-pink rounded-md px-4 py-3 text-body font-semibold hover:bg-moonbeem-pink hover:text-moonbeem-navy transition-colors text-center";
  // Route through /go/offer so the click hits the click-logger.
  // /go/offer redirects to offer.provider_url with outbound UTMs
  // appended; visual rendering of this button is unchanged.
  const href =
    `/go/offer?title_id=${encodeURIComponent(titleId)}` +
    `&title_offer_id=${encodeURIComponent(offer.id)}`;
  // rel="noopener" only — noreferrer would strip the Referer header
  // on the navigation to /go/offer, blanking the referrer column in
  // external_clicks for clicks that originate on moonbeem.studio.
  // noopener stays for security (prevents the destination from
  // accessing window.opener).
  // OfferButtonClient adds the gtag external_click event on click;
  // the visual + redirect behaviour is unchanged from the prior
  // <a href> implementation.
  return (
    <OfferButtonClient
      href={href}
      label={label}
      className={className}
      titleId={titleId}
      offerType={offer.offer_type ?? null}
      destinationUrl={offer.provider_url}
    />
  );
}

export default async function TitlePage({ params }: PageProps) {
  const { slug } = await params;
  const title = await getTitleBySlug(slug);
  if (!title) notFound();
  // Visibility gate: hidden (is_public=false) titles 404 for anon
  // and signed-in non-members. Super-admins and partner-team
  // members of the title's partner pass through.
  const visible = await canViewTitle({
    is_public: title.is_public,
    partner_id: title.partner_id,
  });
  if (!visible) notFound();
  const [offers, fanEdits, clips, stills, hasActiveCampaign, episodes] =
    await Promise.all([
      getActiveOffersForTitle(title.id),
      getActiveFanEditsForTitle(title.id),
      getActiveClipsForTitle(title.id),
      getActiveStillsForTitle(title.id),
      isTitleInActiveCampaign(title.id),
      getTitleEpisodes(title.id),
    ]);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let alreadyRequested = false;
  let requestedAt: string | null = null;
  if (user) {
    const { data: existingRequest } = await supabase
      .from("title_requests")
      .select("requested_at")
      .eq("title_id", title.id)
      .eq("user_id", user.id)
      .eq("request_type", "fan_edits")
      .is("fulfilled_at", null)
      .maybeSingle();
    if (existingRequest) {
      alreadyRequested = true;
      requestedAt = existingRequest.requested_at as string;
    }
  }

  // Gating — the clips + stills tabs need the viewer's tier and
  // lifetime download counts for their quota affordances.
  // Super-admins are coerced to "verified" for the UI (unlimited
  // "Download"); the server-side gate still does the real bypass.
  const gateProfile = await getCurrentProfile();
  const isSuperAdmin = gateProfile?.role === "super_admin";
  const effectiveTier = isSuperAdmin
    ? "verified"
    : await getUserTier(user?.id ?? null);
  const [clipDownloadUsage, stillDownloadUsage] =
    user && !isSuperAdmin
      ? await Promise.all([
          getUsageCount(user.id, "download_clip"),
          getUsageCount(user.id, "download_still"),
        ])
      : [0, 0];

  const metaParts = [
    title.director,
    title.year ? String(title.year) : null,
    title.runtime_min ? `${title.runtime_min} min` : null,
  ].filter((part): part is string => Boolean(part));

  const aboutContent = (
    <div className="flex flex-col items-center gap-8">
      {title.synopsis && (
        <p className="text-body text-moonbeem-ink leading-relaxed max-w-prose text-left">
          {title.synopsis}
        </p>
      )}
      <AboutCredits title={title} />
      {title.is_active && offers.length > 0 && (
        <div className="flex flex-col gap-3 w-full max-w-sm">
          {offers.map((offer) => (
            <OfferButton key={offer.id} offer={offer} titleId={title.id} />
          ))}
        </div>
      )}
      {fanEdits.length === 0 && (
        <RequestFanEditsCTA
          titleId={title.id}
          titleName={title.title}
          titleSlug={title.slug}
          alreadyRequested={alreadyRequested}
          requestedAt={requestedAt}
        />
      )}
    </div>
  );

  const posterEl = title.poster_url ? (
    <div className="w-full max-w-[440px] md:max-w-none rounded-lg overflow-hidden shadow-2xl">
      <TitlePosterShared
        slug={title.slug}
        src={title.poster_url}
        alt={`${title.title} poster`}
      />
    </div>
  ) : (
    <div className="w-full max-w-[440px] md:max-w-none aspect-[2/3] rounded-lg overflow-hidden shadow-2xl bg-gradient-to-br from-moonbeem-navy to-moonbeem-black flex items-center justify-center p-8">
      <p className="font-wordmark text-display-sm text-moonbeem-ink-muted text-center">
        {title.title}
      </p>
    </div>
  );

  return (
    <div className="min-h-screen py-12 px-6">
      <Suspense fallback={null}>
        <RequestSubmittedToast />
      </Suspense>

      <div className="mx-auto max-w-6xl flex flex-col items-center gap-8 md:flex-row md:items-start md:gap-10">
        <div className="w-full max-w-[440px] md:w-[320px] md:max-w-none md:flex-shrink-0 md:sticky md:top-8 md:max-h-[calc(100vh-4rem)] md:overflow-y-auto scrollbar-hide">
          {posterEl}
        </div>

        <div className="w-full md:flex-1 md:min-w-0 flex flex-col items-center gap-8 md:items-stretch">
          <div className="flex flex-col items-center gap-3 max-w-prose text-center md:items-start md:text-left md:max-w-none">
            <h1 className="font-wordmark font-bold text-display-md md:text-display-lg text-moonbeem-pink m-0">
              {title.title}
            </h1>
            {metaParts.length > 0 && (
              <p className="text-body text-moonbeem-ink-muted m-0">
                {metaParts.join(" · ")}
              </p>
            )}
            {title.distributor && (
              <p className="text-body-sm text-moonbeem-ink-subtle m-0">
                Distributed by {title.distributor}
              </p>
            )}
            {/* Active-campaign pill — page chrome, not tab content.
                Lives above the tab strip so creators landing on the
                title page see the cue immediately without clicking
                into Fan Edits. Server-component territory; the
                hasActiveCampaign boolean is resolved in this file
                via isTitleInActiveCampaign (service-role single-
                title check, deny-all RLS bypass). Rendered for both
                anon and signed-in viewers; gating is purely on
                title, not auth. */}
            {hasActiveCampaign ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-moonbeem-pink/15 px-3 py-1 text-body-sm font-medium text-moonbeem-pink">
                Active Campaign · Earn from your Edit
              </div>
            ) : null}
          </div>

          <TitleTabs
            aboutContent={aboutContent}
            watchContent={
              episodes.length > 0 ? <EpisodeList episodes={episodes} /> : undefined
            }
            fanEditsContent={
              <>
                {/* Block 3 entry point: signed-in viewers see a link
                    to /c/<their-handle>/upload?title_id=<this title>.
                    The upload page itself redirects to /me/edit?
                    return_to= if the viewer isn't verified yet, so
                    we don't need a client-side GateModal here. */}
                {gateProfile?.handle ? (
                  <p className="mb-6 text-body-sm text-moonbeem-ink-muted">
                    Made a fan edit for this?{" "}
                    <Link
                      href={`/c/${gateProfile.handle}/upload?title_id=${title.id}`}
                      className="text-moonbeem-pink hover:opacity-90"
                    >
                      Add yours →
                    </Link>
                  </p>
                ) : null}
                <FanEditsTab
                  fanEdits={fanEdits}
                  titleSlug={title.slug}
                  titleName={title.title}
                  titlePosterUrl={title.poster_url}
                />
              </>
            }
            videosContent={
              <VideosTab
                clips={clips}
                tier={effectiveTier}
                clipDownloadUsage={clipDownloadUsage}
              />
            }
            stillsContent={
              <StillsTab
                stills={stills}
                tier={effectiveTier}
                stillDownloadUsage={stillDownloadUsage}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

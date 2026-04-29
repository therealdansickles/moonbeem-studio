import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getActiveClipsForTitle,
  getActiveFanEditsForTitle,
  getActiveOffersForTitle,
  getActiveStillsForTitle,
  getTitleBySlug,
  type TitleOffer,
} from "@/lib/queries/titles";
import TitleTabs from "@/components/TitleTabs";
import FanEditsTab from "@/components/FanEditsTab";
import VideosTab from "@/components/VideosTab";
import StillsTab from "@/components/StillsTab";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const title = await getTitleBySlug(slug);
  if (!title) return { title: "Not found" };
  const description =
    title.synopsis?.slice(0, 160) ?? `Watch ${title.title} on Moonbeem.`;
  return {
    title: `${title.title} on Moonbeem`,
    description,
    openGraph: {
      title: title.title,
      description,
      images: title.poster_url ? [title.poster_url] : [],
    },
  };
}

function OfferButton({ offer }: { offer: TitleOffer }) {
  if (!offer.provider_url) return null;
  const label = offer.provider ?? "Watch";
  const isPrimary = offer.offer_type === "theatrical";
  const className = isPrimary
    ? "bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-3 text-body font-semibold hover:opacity-90 transition-opacity text-center"
    : "bg-transparent border border-moonbeem-pink text-moonbeem-pink rounded-md px-4 py-3 text-body font-semibold hover:bg-moonbeem-pink hover:text-moonbeem-navy transition-colors text-center";
  return (
    <a
      href={offer.provider_url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {label}
    </a>
  );
}

export default async function TitlePage({ params }: PageProps) {
  const { slug } = await params;
  const title = await getTitleBySlug(slug);
  if (!title) notFound();
  const [offers, fanEdits, clips, stills] = await Promise.all([
    getActiveOffersForTitle(title.id),
    getActiveFanEditsForTitle(title.id),
    getActiveClipsForTitle(title.id),
    getActiveStillsForTitle(title.id),
  ]);

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
      {offers.length > 0 && (
        <div className="flex flex-col gap-3 w-full max-w-sm">
          {offers.map((offer) => (
            <OfferButton key={offer.id} offer={offer} />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col items-center gap-8 py-12 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      {title.poster_url && (
        <div className="max-w-[440px] w-full rounded-lg overflow-hidden shadow-2xl">
          <Image
            src={title.poster_url}
            alt={`${title.title} poster`}
            width={600}
            height={900}
            className="w-full h-auto"
            priority
          />
        </div>
      )}

      <div className="flex flex-col items-center gap-3 max-w-prose text-center">
        <h1 className="font-wordmark font-bold text-display-lg text-moonbeem-pink m-0">
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
      </div>

      <TitleTabs
        aboutContent={aboutContent}
        fanEditsContent={<FanEditsTab fanEdits={fanEdits} />}
        videosContent={<VideosTab clips={clips} />}
        stillsContent={<StillsTab stills={stills} />}
      />
    </div>
  );
}

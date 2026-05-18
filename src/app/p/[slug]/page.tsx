// Public partner catalog at /p/[slug]. Visitors land here from the
// homepage partner-logo strip; they expect to see what's on
// Moonbeem from this partner, not analytics. Dashboard moved to
// /p/[slug]/dashboard on 2026-05-12 (Emerson Collective pitch).
//
// Reads via service-role client: matches the convention used by the
// dashboard route and resolves the partners-table RLS gap (no
// public SELECT policy yet — followup queued).
//
// No auth gating. Indexable.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/supabase/service";
import TitleCarousel from "@/components/TitleCarousel";
import PartnerLogoShared from "@/components/PartnerLogoShared";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = createServiceRoleClient();
  const { data: partner } = await supabase
    .from("partners")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) return { title: "Not found" };
  return {
    title: `${partner.name} on Moonbeem`,
    description: `Authorized fan edits for ${partner.name}'s films on Moonbeem.`,
  };
}

export default async function PartnerCatalogPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id, slug, name, logo_url")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) notFound();

  // Active+public titles only. created_at DESC so newer titles
  // surface first; partner-side sorting controls are out of scope
  // for the pitch (deferred to post-pitch).
  const { data: titles } = await supabase
    .from("titles")
    .select("id, slug, title, poster_url")
    .eq("partner_id", partner.id)
    .eq("is_public", true)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  const titleList = titles ?? [];

  return (
    <div className="flex-1 py-12">
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 px-6">
          <Link
            href="/"
            className="text-caption text-moonbeem-ink-muted transition-colors hover:text-moonbeem-pink"
          >
            ← Back to home
          </Link>
        </div>

        <div className="mb-12 flex flex-col items-start gap-6 px-6">
          {partner.logo_url ? (
            // Plain <img>: avoids the next/image domain whitelist
            // requirement for arbitrary R2 public URLs. 144px display
            // height; source is 16:9 so width = 256px.
            // The <PartnerLogoShared> wrapper carries the
            // <ViewTransition name=`partner-logo-${slug}`> that pairs
            // with the homepage strip — clicking a logo morphs into
            // this hero element.
            <PartnerLogoShared
              slug={partner.slug as string}
              src={partner.logo_url as string}
              alt={partner.name as string}
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <h1 className="m-0 font-wordmark text-display-md md:text-display-lg text-moonbeem-pink">
              {partner.name as string}
            </h1>
            <p className="m-0 text-body text-moonbeem-ink-muted">
              {titleList.length}{" "}
              {titleList.length === 1 ? "title" : "titles"}
            </p>
          </div>
        </div>

        {titleList.length > 0 && (
          <TitleCarousel titles={titleList} />
        )}
      </div>
    </div>
  );
}

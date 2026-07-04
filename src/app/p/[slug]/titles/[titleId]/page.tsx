// /p/[slug]/titles/[titleId] — a partner-admin's per-title management surface,
// and the HOME of the DRM uploader (Unit 2b). There was no partner per-title
// surface before this; the uploader needs one (NOT the super-admin admin/titles
// tab).
//
// Auth mirrors /p/[slug]/dashboard + /campaigns/[id]: anonymous and signed-in
// non-members get notFound(); partner-team members (admin OR viewer) and
// super-admins read. The title must belong to the slug's partner (else
// notFound — same response for "doesn't exist" and "different partner", no
// enumeration). The upload/publish/make-public CONTROLS render only for
// partner-ADMINS (the 2a routes also enforce admin server-side, so the
// isPartnerAdmin flag is UI convenience, not the security boundary).

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentProfile, getUser } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import TitleUploadPanel from "@/components/p/TitleUploadPanel";

type PageProps = { params: Promise<{ slug: string; titleId: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = { title: "Title · Moonbeem partner" };

export default async function PartnerTitlePage({ params }: PageProps) {
  const { slug, titleId } = await params;
  if (!UUID_RE.test(titleId)) notFound();

  const user = await getUser();
  if (!user) notFound();

  const supabase = createServiceRoleClient();

  const { data: partner } = await supabase
    .from("partners")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();
  if (!partner) notFound();

  const profile = await getCurrentProfile();
  const isSuperAdmin = profile?.role === "super_admin";
  let isPartnerAdmin = isSuperAdmin;
  if (!isSuperAdmin) {
    const { data: membership } = await supabase
      .from("partner_users")
      .select("role")
      .eq("partner_id", partner.id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!membership) notFound();
    isPartnerAdmin = membership.role === "admin";
  }

  // Title must belong to THIS partner (else notFound — no enumeration).
  const { data: title } = await supabase
    .from("titles")
    .select(
      "id, slug, title, poster_url, media_type, content_kind, is_public, partner_id, allowed_territories, territory_worldwide, transact_enabled, transact_price_cents, purchase_enabled, purchase_price_cents, creator_share_pct, subtitles_burned_in",
    )
    .eq("id", titleId)
    .maybeSingle();
  if (!title || title.partner_id !== partner.id) notFound();

  // Existing assets + their publish state (drives the "already uploaded" view).
  const { data: episodes } = await supabase
    .from("title_episodes")
    .select("id, episode_number, label, source, is_published")
    .eq("title_id", titleId)
    .order("episode_number", { ascending: true });

  // External rental/purchase price (iTunes/Amazon etc.) — guidance only for the
  // pricing card, never enforced. price_usd is NULL across rows today, so this
  // is usually absent; wired for when external prices get scraped in.
  const { data: extOffer } = await supabase
    .from("title_offers")
    .select("price_usd")
    .eq("title_id", titleId)
    .eq("is_active", true)
    .not("price_usd", "is", null)
    .in("offer_type", ["rent", "buy"])
    .order("price_usd", { ascending: true })
    .limit(1)
    .maybeSingle();
  const externalPriceUsd = (extOffer?.price_usd as number | null) ?? null;

  return (
    <div className="min-h-screen px-4 py-6 md:px-6 md:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href={`/p/${partner.slug as string}/dashboard`}
          className="text-caption text-moonbeem-ink-subtle transition-colors hover:text-moonbeem-pink"
        >
          ← {partner.name as string} dashboard
        </Link>
        <h1 className="mt-4 font-wordmark text-display-sm md:text-display-md text-moonbeem-ink m-0">
          {title.title as string}
        </h1>
        <p className="mt-1 text-body-sm text-moonbeem-ink-muted m-0">
          {title.is_public
            ? "Public · listed in the catalog"
            : "Private draft · not yet public"}
        </p>

        <div className="mt-8">
          <TitleUploadPanel
            titleId={title.id as string}
            titleSlug={title.slug as string}
            filmTitle={title.title as string}
            contentKind={(title.content_kind as string | null) ?? "film"}
            currentPosterUrl={(title.poster_url as string | null) ?? null}
            isPublic={title.is_public as boolean}
            isPartnerAdmin={isPartnerAdmin}
            episodes={(episodes ?? []).map((e) => ({
              id: e.id as string,
              episode_number: e.episode_number as number,
              label: (e.label as string | null) ?? null,
              source: e.source as string,
              is_published: e.is_published as boolean,
            }))}
            territoryWorldwide={(title.territory_worldwide as boolean) ?? false}
            allowedTerritories={
              (title.allowed_territories as string[] | null) ?? []
            }
            transactEnabled={(title.transact_enabled as boolean) ?? false}
            transactPriceCents={
              (title.transact_price_cents as number | null) ?? null
            }
            purchaseEnabled={(title.purchase_enabled as boolean) ?? false}
            purchasePriceCents={
              (title.purchase_price_cents as number | null) ?? null
            }
            creatorSharePct={(title.creator_share_pct as number | null) ?? null}
            externalPriceUsd={externalPriceUsd}
            subtitlesBurnedIn={(title.subtitles_burned_in as boolean | null) ?? false}
          />
        </div>
      </div>
    </div>
  );
}

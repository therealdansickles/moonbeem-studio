// /admin/titles/[slug] — operational hub for a single title.
//
// Super-admin only. The page is the single landing for everything
// scoped to one title: fan edits (with delete), uploads (CSV fan
// edits + clips/stills), and settings (status flags, partner
// attribution).
//
// Reads via service-role; the underlying tables (fan_edits,
// titles, partners) all use the cookie-aware client elsewhere but
// admin needs to see soft-deleted rows for restore/audit.

import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireSuperAdminOr404 } from "@/lib/dal";
import { createServiceRoleClient } from "@/lib/supabase/service";
import TitleDetailTabs, { type FanEditRow } from "./TitleDetailTabs";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `${slug} · admin · Moonbeem`,
    robots: { index: false, follow: false },
  };
}

const ALLOWED_TABS = ["fan-edits", "upload", "settings"] as const;
type Tab = (typeof ALLOWED_TABS)[number];

function parseTab(raw: string | undefined): Tab {
  if (raw && (ALLOWED_TABS as readonly string[]).includes(raw)) {
    return raw as Tab;
  }
  return "fan-edits";
}

export default async function AdminTitleDetailPage({
  params,
  searchParams,
}: PageProps) {
  await requireSuperAdminOr404();
  const { slug } = await params;
  const { tab } = await searchParams;

  // Catch the bare /admin/titles route by way of typo / stale link.
  if (!slug || slug === "_") redirect("/admin");

  const supabase = createServiceRoleClient();
  const { data: title, error: titleErr } = await supabase
    .from("titles")
    .select(
      "id, slug, title, is_active, is_public, partner_id, deleted_at, partners:partner_id(name, slug)",
    )
    .eq("slug", slug)
    .maybeSingle();
  if (titleErr) {
    throw new Error(`title load failed: ${titleErr.message}`);
  }
  if (!title) notFound();

  const t = title as unknown as {
    id: string;
    slug: string;
    title: string;
    is_active: boolean;
    is_public: boolean;
    partner_id: string | null;
    deleted_at: string | null;
    partners: { name: string; slug: string } | null;
  };

  const { data: edits, error: editsErr } = await supabase
    .from("fan_edits")
    .select(
      "id, platform, embed_url, caption, view_count, like_count, posted_at, thumbnail_url, creator_id, creator_handle_displayed, deleted_at, created_at",
    )
    .eq("title_id", t.id)
    .order("created_at", { ascending: false });
  if (editsErr) {
    throw new Error(`fan_edits load failed: ${editsErr.message}`);
  }
  const editRows = (edits ?? []) as Array<{
    id: string;
    platform: string;
    embed_url: string | null;
    caption: string | null;
    view_count: number | null;
    like_count: number | null;
    posted_at: string | null;
    thumbnail_url: string | null;
    creator_id: string | null;
    creator_handle_displayed: string | null;
    deleted_at: string | null;
    created_at: string;
  }>;

  // Resolve creator handles via public_creators (RLS-readable view).
  const creatorIds = Array.from(
    new Set(
      editRows
        .map((e) => e.creator_id)
        .filter((id): id is string => !!id),
    ),
  );
  const handleById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabase
      .from("public_creators")
      .select("id, moonbeem_handle")
      .in("id", creatorIds);
    for (const c of creators ?? []) {
      handleById.set(c.id as string, c.moonbeem_handle as string);
    }
  }

  const fanEdits: FanEditRow[] = editRows.map((e) => ({
    id: e.id,
    platform: e.platform,
    embed_url: e.embed_url,
    caption: e.caption,
    view_count: e.view_count ?? 0,
    like_count: e.like_count ?? 0,
    posted_at: e.posted_at,
    thumbnail_url: e.thumbnail_url,
    creator_handle: e.creator_id
      ? handleById.get(e.creator_id) ?? null
      : e.creator_handle_displayed ?? null,
    moonbeem_handle: e.creator_id
      ? handleById.get(e.creator_id) ?? null
      : null,
    deleted_at: e.deleted_at,
    created_at: e.created_at,
  }));

  return (
    <TitleDetailTabs
      titleId={t.id}
      titleSlug={t.slug}
      titleName={t.title}
      isActive={t.is_active}
      isPublic={t.is_public}
      partnerName={t.partners?.name ?? null}
      partnerSlug={t.partners?.slug ?? null}
      hasPartner={!!t.partner_id}
      fanEdits={fanEdits}
      activeTab={parseTab(tab)}
    />
  );
}
